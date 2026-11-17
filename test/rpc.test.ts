import assert from "node:assert/strict";
import { test } from "node:test";
import { McpClient, readSse, RpcError } from "../src/rpc.ts";
import { answerInit, EVENTS_CAPS, MemoryTransport } from "./memory-transport.ts";

function stream(text: string): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	return new ReadableStream({
		start(c) {
			// Split in odd places to test buffering.
			for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
			c.close();
		},
	});
}

test("readSse joins data lines and splits events on blank lines", async () => {
	const out: string[] = [];
	for await (const d of readSse(stream(': comment\r\ndata: {"a":1}\r\n\r\nevent: message\ndata: {"b":\ndata: 2}\n\ndata: tail'))) out.push(d);
	assert.deepEqual(out, ['{"a":1}', '{"b":\n2}', "tail"]);
});

test("the events capability is read only from capabilities.extensions", async () => {
	const client = new McpClient(new MemoryTransport((m, t) => answerInit(m, t, EVENTS_CAPS)));
	await client.connect("test");
	assert.ok(client.eventsCapability);
	// The top-level `events` key of the early design sketch is not part of SEP-3415.
	for (const caps of [{ events: { listChanged: false } }, { tools: {} }]) {
		const old = new McpClient(new MemoryTransport((m, t) => answerInit(m, t, caps)));
		await old.connect("test");
		assert.equal(old.eventsCapability, undefined);
	}
});

test("the client declares the events extension in initialize", async () => {
	const t = new MemoryTransport((m, t) => answerInit(m, t, EVENTS_CAPS));
	await new McpClient(t).connect("test");
	assert.deepEqual(t.sent[0].params.capabilities.extensions, { "io.modelcontextprotocol/events": {} });
	assert.equal(t.sent[1].method, "notifications/initialized");
});

test("requests resolve, errors reject with RpcError, ping is answered", async () => {
	const t = new MemoryTransport((m, t) => {
		if (answerInit(m, t, EVENTS_CAPS)) return;
		if (m.method === "ok") t.emit({ id: m.id, result: { fine: true } });
		if (m.method === "bad") t.emit({ id: m.id, error: { code: -32023, message: "NotFound" } });
	});
	const client = new McpClient(t);
	await client.connect("test");
	assert.deepEqual(await client.request("ok"), { fine: true });
	await assert.rejects(client.request("bad"), (e: unknown) => e instanceof RpcError && e.code === -32023);
	t.emit({ id: 99, method: "ping" });
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(t.sent.at(-1), { jsonrpc: "2.0", id: 99, result: {} });
});

test("cancel sends notifications/cancelled on stdio; close rejects pending requests", async () => {
	const t = new MemoryTransport((m, t) => answerInit(m, t, EVENTS_CAPS));
	const client = new McpClient(t);
	await client.connect("test");
	const call = client.start("events/stream", { name: "x" }, { timeoutMs: 0 });
	client.cancel(call.id, "done");
	assert.equal(await call.done, undefined);
	assert.deepEqual(t.sent.at(-1), { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: call.id, reason: "done" } });
	const pending = client.request("never", undefined, { timeoutMs: 0 });
	t.die();
	await assert.rejects(pending, /server exited/);
	assert.equal(client.closed, true);
});
