import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ServerEntry } from "../src/config.ts";
import type { RpcMessage } from "../src/rpc.ts";
import { StateStore } from "../src/state.ts";
import { type EventOccurrence, ServerPool, Subscription, timing } from "../src/subscription.ts";
import { answerInit, EVENTS_CAPS, type Handler, MemoryTransport, waitFor } from "./memory-transport.ts";

timing.pollFloorMs = 20;
timing.heartbeatMs = 50;
timing.retryBaseMs = 10;

const SUB_ID = "io.modelcontextprotocol/subscriptionId";

function harness(handler: Handler, delivery: string[]) {
	const transports: MemoryTransport[] = [];
	const servers = new Map<string, ServerEntry>([["srv", { name: "srv", config: { command: "unused" }, source: "user" }]]);
	const pool = new ServerPool(servers, {
		cwd: "/",
		version: "test",
		log: () => {},
		makeTransport: () => {
			const t = new MemoryTransport((m, t) => {
				if (answerInit(m, t, EVENTS_CAPS)) return;
				if (m.method === "events/list") return t.emit({ id: m.id, result: { events: [{ name: "ev", delivery }] } });
				handler(m, t);
			});
			transports.push(t);
			return t;
		},
	});
	const state = new StateStore(join(mkdtempSync(join(tmpdir(), "pme-sub-")), "state.json"));
	const delivered: EventOccurrence[] = [];
	const gaps: boolean[] = [];
	const sub = new Subscription({
		spec: { server: "srv", event: "ev", arguments: { a: 1 } },
		source: "runtime",
		pool,
		state,
		deliver: (_s, events, gap) => {
			delivered.push(...events);
			gaps.push(gap);
		},
		log: () => {},
	});
	return { sub, pool, state, delivered, gaps, transports };
}

const ev = (id: string) => ({ eventId: id, name: "ev", timestamp: "2026-01-01T00:00:00Z", data: { id } });

test("poll: honors cursor and hasMore, dedupes by eventId, applies the nextPollMs floor", async (tc) => {
	// The hasMore gap includes an fsynced outbox write; a 20 ms floor is too tight under parallel test I/O.
	const floor = timing.pollFloorMs;
	timing.pollFloorMs = 250;
	tc.after(() => { timing.pollFloorMs = floor; });
	const polls: RpcMessage[] = [];
	const times: number[] = [];
	const h = harness((m, t) => {
		if (m.method !== "events/poll") return;
		polls.push(m);
		times.push(Date.now());
		const n = polls.length;
		const result =
			n === 1
				? { events: [], cursor: "c1", hasMore: false, nextPollMs: 0 }
				: n === 2
					? { events: [ev("e1"), ev("e2")], cursor: "c2", hasMore: true, nextPollMs: 0 }
					: n === 3
						? { events: [ev("e2"), ev("e3")], cursor: "c3", truncated: true, hasMore: false, nextPollMs: 0 }
						: { events: [], cursor: "c3", hasMore: false, nextPollMs: 0 };
		t.emit({ id: m.id, result });
	}, ["poll"]);
	h.sub.start();
	try {
		await h.sub.ready;
		assert.equal(h.sub.mode, "poll");
		await waitFor(() => polls.length >= 5);
	} finally {
		h.sub.stop();
	}
	assert.deepEqual(polls.map((p) => p.params.cursor).slice(0, 4), [null, "c1", "c2", "c3"]);
	assert.deepEqual(polls[0].params.arguments, { a: 1 });
	assert.deepEqual(h.delivered.map((e) => e.eventId), ["e1", "e2", "e3"]);
	assert.deepEqual(h.gaps, [false, true]);
	// hasMore polls again at once; otherwise wait at least the floor even when nextPollMs is 0.
	assert.ok(times[2] - times[1] < timing.pollFloorMs, "hasMore should not wait");
	assert.ok(times[1] - times[0] >= timing.pollFloorMs - 2, "floor should apply");
	assert.equal(h.state.cursor(h.sub.key), "c3");
});

test("push: routes by subscriptionId, advances the cursor on heartbeat, delivers events", async () => {
	const h = harness((m, t) => {
		if (m.method !== "events/stream") return;
		const meta = { [SUB_ID]: m.id };
		t.emit({ method: "notifications/events/active", params: { cursor: "c0", truncated: false, _meta: meta } });
		t.emit({ method: "notifications/events/event", params: { ...ev("other"), _meta: { [SUB_ID]: 12345 } } });
		t.emit({ method: "notifications/events/event", params: { ...ev("e1"), cursor: "c1", _meta: meta } });
		t.emit({ method: "notifications/events/heartbeat", params: { cursor: "c2", _meta: meta } });
	}, ["push", "poll"]);
	h.sub.start();
	try {
		await h.sub.ready;
		assert.equal(h.sub.mode, "push");
		await waitFor(() => h.state.cursor(h.sub.key) === "c2");
		assert.deepEqual(h.delivered.map((e) => e.eventId), ["e1"]);
	} finally {
		h.sub.stop();
	}
	const last = h.transports[0].sent.at(-1)!;
	assert.equal(last.method, "notifications/cancelled");
});

test("push: a silent stream is cancelled and reopened with the last cursor", async () => {
	const streams: RpcMessage[] = [];
	const h = harness((m, t) => {
		if (m.method !== "events/stream") return;
		streams.push(m);
		const meta = { [SUB_ID]: m.id };
		t.emit({ method: "notifications/events/active", params: { cursor: `c${streams.length}`, _meta: meta } });
		// then silence: no heartbeat
	}, ["push"]);
	h.sub.start();
	try {
		await waitFor(() => streams.length >= 2, 5000);
	} finally {
		h.sub.stop();
	}
	assert.equal(streams[0].params.cursor, null);
	assert.equal(streams[1].params.cursor, "c1");
	assert.ok(h.transports[0].sent.some((m) => m.method === "notifications/cancelled" && m.params.requestId === streams[0].id));
});

test("push: terminated ends the subscription", async () => {
	const h = harness((m, t) => {
		if (m.method !== "events/stream") return;
		const meta = { [SUB_ID]: m.id };
		t.emit({ method: "notifications/events/active", params: { cursor: null, _meta: meta } });
		setTimeout(() => t.emit({ method: "notifications/events/terminated", params: { error: { code: -32024, message: "Forbidden" }, _meta: meta } }), 10);
	}, ["push"]);
	h.sub.start();
	await h.sub.ready;
	await waitFor(() => h.sub.status === "failed");
	assert.match(h.sub.lastError ?? "", /terminated by server: Forbidden/);
});

test("a server restart reconnects and resumes from the stored cursor", async () => {
	const streams: RpcMessage[] = [];
	const h = harness((m, t) => {
		if (m.method !== "events/stream") return;
		streams.push(m);
		const meta = { [SUB_ID]: m.id };
		t.emit({ method: "notifications/events/active", params: { cursor: "c-live", _meta: meta } });
		if (streams.length === 1) setTimeout(() => t.die(), 10);
	}, ["push"]);
	h.sub.start();
	try {
		await waitFor(() => streams.length >= 2, 5000);
	} finally {
		h.sub.stop();
	}
	assert.equal(h.transports.length, 2, "a new connection");
	assert.equal(streams[1].params.cursor, "c-live");
});

test("unknown events and webhook-only events fail without retry", async () => {
	const unknown = harness(() => {}, ["push"]);
	const s1 = new Subscription({ ...unknownArgs(unknown), spec: { server: "srv", event: "nope", arguments: {} } });
	s1.start();
	await assert.rejects(s1.ready, /no event "nope"/);
	const webhook = harness(() => {}, ["webhook"]);
	webhook.sub.start();
	await assert.rejects(webhook.sub.ready, /supports push and poll/);
	assert.equal(webhook.sub.status, "failed");
});

function unknownArgs(h: ReturnType<typeof harness>) {
	return { source: "runtime" as const, pool: h.pool, state: h.state, deliver: () => {}, log: () => {} };
}

test("push: a schema_changed termination lists events again and resubscribes", async () => {
	const streams: RpcMessage[] = [];
	let lists = 0;
	const h = harness((m, t) => {
		if (m.method !== "events/stream") return;
		streams.push(m);
		const meta = { [SUB_ID]: m.id };
		t.emit({ method: "notifications/events/active", params: { cursor: "c1", heartbeatMs: 1000, _meta: meta } });
		if (streams.length === 1) {
			const error = { code: -32026, message: "Unsupported", data: { feature: "payloadSchema", reason: "schema_changed" } };
			setTimeout(() => t.emit({ method: "notifications/events/terminated", params: { error, _meta: meta } }), 5);
		}
	}, ["push"]);
	const list = h.pool.events.bind(h.pool);
	h.pool.events = (name: string) => (lists++, list(name));
	h.sub.start();
	try {
		await waitFor(() => streams.length >= 2, 5000);
	} finally {
		h.sub.stop();
	}
	assert.equal(lists, 2, "events/list is fetched again");
	assert.equal(streams[1].params.cursor, "c1");
	assert.equal(streams[0].params.heartbeatMs, timing.heartbeatMs, "the client suggests a heartbeat interval");
	assert.deepEqual(streams[0].params._meta["io.modelcontextprotocol/clientCapabilities"], {
		extensions: { "io.modelcontextprotocol/events": {} },
	});
	assert.notEqual(h.sub.status, "failed");
});
