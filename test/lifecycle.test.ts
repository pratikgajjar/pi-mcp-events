import assert from "node:assert/strict";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { waitFor } from "./memory-transport.ts";

const cap = { extensions: { "io.modelcontextprotocol/events": {} } };
const events = Array.from({ length: 11 }, (_, i) => ({ eventId: `event-${i + 1}`, name: "changed", data: { text: i === 10 ? "x".repeat(21000) : `data-${i + 1}`, tail: `TAIL-${i + 1}` }, cursor: `c${i + 1}` }));

async function fixture(t: TestContext, mode: "push" | "poll") {
	const dir = mkdtempSync(join(tmpdir(), "pme-lifecycle-"));
	const requests: any[] = [], modelRequests: any[] = [];
	let hold = true;
	let blockedMethod = "";
	const startupWaiters: (() => void)[] = [];
	const held: ServerResponse[] = [], streams: { res: ServerResponse; id: unknown }[] = [];
	const complete = (res: ServerResponse) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
	};
	const note = (res: ServerResponse, id: unknown, method: string, params: any) => res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: `notifications/events/${method}`, params: { ...params, _meta: { "io.modelcontextprotocol/subscriptionId": id } } })}\n\n`);
	const server = createServer(async (req, res) => {
		if (req.method === "DELETE") return res.writeHead(200).end();
		let raw = ""; for await (const chunk of req) raw += chunk;
		const msg = raw ? JSON.parse(raw) : {};
		if (req.url === "/v1/chat/completions") { modelRequests.push(msg); if (hold) held.push(res); else complete(res); return; }
		requests.push({ ...msg, url: req.url });
		const reply = (result: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })); };
		if (msg.method === blockedMethod) await new Promise<void>((resolve) => startupWaiters.push(resolve));
		if (msg.method === "initialize") return reply({ protocolVersion: "2025-11-25", capabilities: cap });
		if (msg.method === "events/list") return reply({ events: [{ name: "changed", delivery: [mode] }, { name: "keeper", delivery: [mode] }] });
		if (msg.method === "events/poll") return reply({ events: msg.params.cursor ? [] : events, cursor: "c11", nextPollMs: 1000 });
		if (msg.method === "events/stream") {
			res.writeHead(200, { "content-type": "text/event-stream" }); streams.push({ res, id: msg.id });
			note(res, msg.id, "active", { cursor: msg.params.cursor ?? (msg.params.name === "keeper" ? "keeper-0" : null) });
			if (!msg.params.cursor && msg.params.name !== "keeper") for (const e of events) note(res, msg.id, "event", e);
			return;
		}
		res.writeHead(202).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: `${url}/mcp` } } }));
	const children: ChildProcess[] = [];
	t.after(async () => {
		for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await Promise.all(children.map((c) => c.exitCode !== null || c.signalCode !== null ? undefined : new Promise((r) => c.once("exit", r))));
		server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r()));
		rmSync(dir, { recursive: true, force: true });
	});
	const start = async (extra: object = {}) => {
		const child = fork(new URL("./lifecycle-worker.ts", import.meta.url), [JSON.stringify({ dir, url, ...extra })], { env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
		children.push(child);
		const messages: any[] = []; let stderr = "";
		child.stderr?.on("data", (b) => { stderr += b; });
		child.stdout?.on("data", () => {});
		child.on("message", (m) => messages.push(m));
		t.after(() => { if (t.error) console.error(JSON.stringify(messages), stderr); });
		await waitFor(() => messages.some((m) => m.type === "ready") || child.exitCode !== null, 15000);
		assert.equal(child.exitCode, null, stderr);
		let id = 0;
		return { child, messages, ready: messages.find((m) => m.type === "ready"),
			async request(action: string, params?: unknown) { const n = ++id; child.send({ id: n, action, params }); await waitFor(() => messages.some((m) => m.id === n), 15000); return messages.find((m) => m.id === n); },
			async command(action: string, params?: unknown) { const result = await this.request(action, params); assert(!result.error, result.error + stderr); return result; } };
	};
	const root = join(dir, "mcp-events");
	const files = (suffix: string) => existsSync(root) ? readdirSync(root).filter((f) => f.endsWith(suffix)).sort() : [];
	const snapshots = () => readdirSync(join(dir, "mcp-events")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, "mcp-events", f), "utf8")));
	return { dir, url, root, files, requests, modelRequests, start, snapshots, block: (method: string) => { blockedMethod = method; }, releaseStartup: () => { blockedMethod = ""; for (const resolve of startupWaiters.splice(0)) resolve(); }, release: () => { hold = false; for (const res of held.splice(0)) complete(res); }, note, streams };
}

for (const mode of ["push", "poll"] as const) {
	test(`real Pi ${mode}: crash before append, restart, full payloads, reload, new session and resume`, { timeout: 60000 }, async (t) => {
		const f = await fixture(t, mode);
		// Independent HTTP client: no extension RPC or transport code.
		const raw = async (method: string, params: any = {}) => (await (await fetch(`${f.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 900, method, params }) })).json()).result;
		assert.deepEqual((await raw("initialize")).capabilities, cap);
		assert.equal((await raw("events/list")).events[0].delivery[0], mode);
		assert.equal((await raw("events/poll", { cursor: null })).events.length, 11);
		if (mode === "push") {
			const response = await fetch(`${f.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 901, method: "events/stream", params: { cursor: null } }) });
			const reader = response.body!.getReader(); let wire = "";
			while (!wire.includes("TAIL-11")) { const next = await reader.read(); assert(!next.done); wire += new TextDecoder().decode(next.value); }
			await reader.cancel(); assert(wire.includes('"eventId":"event-11"'));
		}
		const a = await f.start({ pauseBeforeAppend: true });
		await a.command("prompt"); await waitFor(() => f.modelRequests.length > 0 || a.messages.some((m) => m.type === "prompt_error"), 10000);
		assert(f.modelRequests.length > 0, JSON.stringify(a.messages));
		await a.command("subscribe", { server: "fixture", event: "changed", delivery: mode });
		await waitFor(() => f.snapshots()[0].pending.length >= 13, 10000);
		assert(!readFileSync(a.ready.file, "utf8").includes('"customType":"mcp-event"'), "busy queue is not a transcript receipt");
		a.child.kill("SIGKILL"); await new Promise((r) => a.child.once("exit", r));
		// Resume without releasing the held model: outbox replay alone reaches message_end.
		const mid = await f.start({ sessionFile: a.ready.file, pauseBeforeAppend: true });
		await waitFor(() => mid.messages.some((m) => m.type === "message_end"), 10000);
		const boundary = mid.messages.find((m) => m.type === "message_end");
		assert.equal(boundary.persisted, false, "real Pi message_end precedes append");
		assert(f.snapshots()[0].pending.some((r: any) => r.id === boundary.receiptId));
		mid.child.kill("SIGKILL"); await new Promise((r) => mid.child.once("exit", r));
		f.release();
		const b = await f.start({ sessionFile: a.ready.file });
		assert.equal(b.ready.id, a.ready.id);
		await waitFor(() => f.snapshots()[0].pending.length === 0, 15000);
		const entries = readFileSync(a.ready.file, "utf8").trim().split("\n").map((s) => JSON.parse(s)).filter((e) => e.customType === "mcp-event");
		assert.equal(entries.length, 13);
		const contents = entries.map((e) => e.content).join("\n");
		for (let i = 1; i <= 10; i++) assert(contents.includes(`TAIL-${i}`));
		const fragments = entries.filter((e) => e.content.includes("<mcp-event-fragment"));
		const whole = JSON.parse(fragments.map((e) => JSON.parse(e.content.split("\n")[3])).join(""));
		assert.deepEqual(whole.data, events[10].data); assert.equal(whole.eventId, events[10].eventId);
		assert(f.modelRequests.some((r) => JSON.stringify(r.messages).includes("TAIL-11")), "full tail reaches an actual model HTTP request");
		await b.command("reload");
		assert(b.messages.some((m) => m.type === "start" && m.reason === "reload" && m.id === a.ready.id));
		assert.equal(f.snapshots().length, 1, "reload preserves consumer identity");
		await b.command("new");
		await b.command("subscribe", { server: "fixture", event: "changed", delivery: mode });
		await waitFor(() => f.snapshots().length === 2 && f.snapshots().every((s) => s.pending.length === 0 && Object.values(s.subscriptions).some((e: any) => e.seen.length === 11)), 15000);
		await b.command("resume", { file: a.ready.file });
		assert(b.messages.some((m) => m.type === "start" && m.reason === "resume" && m.id === a.ready.id));
		assert.equal(f.snapshots().length, 2, "resume reuses the original namespace");
		assert(!b.messages.some((m) => m.type === "extension_error"), JSON.stringify(b.messages));
		// A different endpoint behind the same alias must not inherit the old cursor/seen IDs.
		writeFileSync(join(f.dir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { url: `${f.url}/different-endpoint` } } }));
		await b.command("reload");
		await waitFor(() => f.snapshots().every((s) => s.pending.length === 0) && f.snapshots().some((s) => Object.values(s.subscriptions).filter((e: any) => e.seen.length === 11).length === 2), 15000);
		assert(f.requests.some((r) => r.url === "/different-endpoint" && (r.method === "events/poll" || r.method === "events/stream") && r.params.cursor === null));
		await b.command("shutdown");
		console.log(`${mode}: independent HTTP client + real Pi queue/message_end/SIGKILL/restart/reload/new/resume; 13 complete pages persisted`);
	});
}

test("real Pi concurrent consumers keep independent pending events", { timeout: 30000 }, async (t) => {
	const f = await fixture(t, "push");
	const a = await f.start(); await a.command("prompt");
	await waitFor(() => f.modelRequests.length > 0);
	await a.command("subscribe", { server: "fixture", event: "changed" });
	await waitFor(() => f.snapshots().some((s) => s.pending.length === 13));
	const b = await f.start(); await b.command("prompt");
	await waitFor(() => f.modelRequests.length > 1);
	await b.command("subscribe", { server: "fixture", event: "changed" });
	await waitFor(() => f.snapshots().length === 2 && f.snapshots().every((s) => s.pending.length === 13));
	assert.notEqual(a.ready.id, b.ready.id);
	assert(!readFileSync(a.ready.file, "utf8").includes('"customType":"mcp-event"'));
	assert(!readFileSync(b.ready.file, "utf8").includes('"customType":"mcp-event"'));
});

test("real Pi live config disable retires a stream and endpoint changes isolate replay", { timeout: 30000 }, async (t) => {
	const f = await fixture(t, "push");
	const a = await f.start(); await a.command("prompt");
	await waitFor(() => f.modelRequests.length > 0);
	await a.command("subscribe", { server: "fixture", event: "changed" });
	await waitFor(() => f.snapshots()[0].pending.length === 13);
	const original = f.streams.at(-1)!;
	await a.command("config", { url: `${f.url}/mcp`, enabled: false });
	await waitFor(() => original.res.destroyed);
	f.note(original.res, original.id, "event", { eventId: "after-disable", name: "changed", data: {}, cursor: "bad" });
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(f.snapshots()[0].pending.length, 13);
	await a.command("config", { url: `${f.url}/other`, headers: { "x-fixture": "new" } });
	await waitFor(() => f.snapshots()[0].pending.length === 26);
	assert(f.requests.some((r) => r.url === "/other" && r.method === "events/stream" && r.params.cursor === null));
	assert.equal(Object.keys(f.snapshots()[0].subscriptions).length, 2);
});

for (const boundary of ["initialize", "events/list"]) {
	test(`real HTTP unsubscribe during ${boundary} prevents stream creation and delivery`, { timeout: 30000 }, async (t) => {
		const f = await fixture(t, "push"); f.block(boundary);
		const a = await f.start();
		const subscribing = a.command("subscribe", { server: "fixture", event: "changed" });
		await waitFor(() => f.requests.some((r) => r.method === boundary));
		// Another subscription owns the same connection, so unsubscribe cannot hide a missing fence by closing it.
		const keeping = a.command("subscribe", { server: "fixture", event: "keeper" });
		await waitFor(() => f.snapshots().some((s) => Object.keys(s.subscriptions).length === 2));
		const unsubscribing = a.command("unsubscribe", { server: "fixture", event: "changed" });
		await waitFor(() => f.snapshots().some((s) => Object.values(s.subscriptions).some((e: any) => e.active === false)));
		f.releaseStartup(); await Promise.all([subscribing, unsubscribing, keeping]);
		await new Promise((r) => setTimeout(r, 100));
		assert(!f.requests.some((r) => r.method === "events/stream" && r.params.name === "changed"));
		assert(f.snapshots().every((s) => s.pending.length === 0));
		assert(!a.messages.some((m) => m.type === "message_end"));
		await a.command("shutdown");
	});
}

const keeper = { server: "fixture", event: "keeper" };
const noExtensionErrors = (w: { messages: any[] }) => assert(!w.messages.some((m) => m.type === "extension_error"), JSON.stringify(w.messages));

test("real Pi empty sessions leave no lock or state; closed sessions keep only needed state", { timeout: 60000 }, async (t) => {
	const f = await fixture(t, "push");
	const workers = await Promise.all([f.start(), f.start(), f.start(), f.start()]);
	await Promise.all(workers.map(async (w) => { await w.command("reload"); for (let i = 0; i < 4; i++) await w.command("new"); }));
	assert(!existsSync(f.root), "no state directory without subscriptions");
	const a = workers[0];
	await a.command("subscribe", keeper);
	assert.equal(f.files(".json").length, 1); assert.equal(f.files(".json.lock").length, 1);
	await a.command("unsubscribe", keeper); await a.command("new");
	assert.deepEqual([...f.files(".json"), ...f.files(".lock")], [], "unsubscribed session leaves nothing");
	await a.command("subscribe", keeper); await a.command("new");
	assert.equal(f.files(".json").length, 1, "runtime intent survives close"); assert.deepEqual(f.files(".lock"), []);
	// A global subscription gives each session cursor-only state; closing removes only the lock.
	writeFileSync(join(f.dir, "mcp-events.json"), JSON.stringify({ subscriptions: [keeper] }));
	for (let i = 0; i < 3; i++) {
		await a.command("new");
		await waitFor(() => f.snapshots().filter((s) => Object.values(s.subscriptions).some((e: any) => e.cursor === "keeper-0" && e.source === "config")).length === i + 1);
	}
	for (const w of workers) await w.command("shutdown");
	assert.equal(f.files(".json").length, 4); assert.deepEqual(f.files(".lock"), []); assert.deepEqual(f.files("-journal"), []);
	for (const w of workers) noExtensionErrors(w);
});

test("real Pi startup survives full slots, a busy owner and corrupt state; subscriptions fail visibly", { timeout: 60000 }, async (t) => {
	const f = await fixture(t, "push"); f.release();
	mkdirSync(f.root, { recursive: true, mode: 0o700 });
	const held = { k: { cursor: "c", seen: [], spec: { server: "other", event: "changed", arguments: {} }, active: true, source: "runtime" } };
	for (let i = 0; i < 1024; i++) writeFileSync(join(f.root, `held-${i}.json`), JSON.stringify({ version: 2, subscriptions: held, pending: [] }));
	const a = await f.start();
	assert.match((await a.request("subscribe", keeper)).error, /slots full: 1024 sessions/);
	await a.command("list");
	rmSync(join(f.root, "held-0.json"));
	await a.command("prompt"); await waitFor(() => existsSync(a.ready.file) && readFileSync(a.ready.file, "utf8").includes('"role":"assistant"'));
	await a.command("subscribe", keeper);
	// The same session resumed elsewhere: the live owner excludes it, without breaking its startup.
	const b = await f.start({ sessionFile: a.ready.file });
	assert.equal(b.ready.id, a.ready.id);
	assert.match((await b.request("subscribe", keeper)).error, /busy/);
	await a.command("shutdown");
	await b.command("subscribe", keeper);
	assert.equal(f.files(".json.lock").length, 1);
	await b.command("shutdown");
	assert.deepEqual(f.files(".lock"), []);
	const own = f.files(".json").filter((n) => !n.startsWith("held-"));
	assert.equal(own.length, 1);
	writeFileSync(join(f.root, own[0]), "not JSON");
	const c = await f.start({ sessionFile: a.ready.file });
	assert.match((await c.request("subscribe", keeper)).error, /JSON/);
	await c.command("shutdown");
	assert.equal(readFileSync(join(f.root, own[0]), "utf8"), "not JSON", "corrupt state is preserved");
	assert.deepEqual(f.files(".lock"), []);
	for (const w of [a, b, c]) noExtensionErrors(w);
});

test("real Pi removes 0.1.1 leftover locks only when no live owner holds them", { timeout: 30000 }, async (t) => {
	const f = await fixture(t, "push");
	mkdirSync(f.root, { recursive: true, mode: 0o700 });
	for (let i = 0; i < 5; i++) { const db = new DatabaseSync(join(f.root, `old-${i}.json.lock`)); db.exec("BEGIN EXCLUSIVE"); db.close(); }
	writeFileSync(join(f.root, "old-0.json.lock-journal"), "");
	// An owner in another process, like a running 0.1.1 session.
	const holder = spawn(process.execPath, ["-e", 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.exec("BEGIN EXCLUSIVE"); console.log("locked"); setInterval(() => {}, 1e6);', join(f.root, "live.json.lock")], { stdio: ["ignore", "pipe", "inherit"] });
	t.after(() => { if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL"); });
	let out = ""; holder.stdout!.on("data", (b) => { out += b; });
	await waitFor(() => out.includes("locked"), 10000);
	const a = await f.start();
	await waitFor(() => f.files(".json.lock").length === 1);
	assert.deepEqual(f.files(".json.lock"), ["live.json.lock"]);
	holder.kill("SIGKILL"); await new Promise((r) => holder.once("exit", r));
	await a.command("reload");
	assert.deepEqual([...f.files(".lock"), ...f.files("-journal")], []);
	assert.deepEqual(f.files(".json"), []);
	await a.command("shutdown");
	noExtensionErrors(a);
});
