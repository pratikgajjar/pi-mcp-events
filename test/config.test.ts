import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadServers, loadSubscriptions, resolveValue, stableStringify, subscriptionKey, unsupportedReason } from "../src/config.ts";

function setup() {
	const root = mkdtempSync(join(tmpdir(), "pme-config-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(
		join(agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				inbox: { command: "inbox-mcp", args: ["--as", "me"] },
				docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
			},
		}),
	);
	writeFileSync(
		join(cwd, ".pi", "mcp.json"),
		JSON.stringify({ mcpServers: { inbox: { enabled: false }, local: { command: "local-mcp" } } }),
	);
	return { agentDir, cwd };
}

test("loadServers reads the user file and a trusted project file", () => {
	const { agentDir, cwd } = setup();
	const { servers } = loadServers({ agentDir, cwd, trusted: true, registered: [{ name: "ext", config: { command: "x" } }] });
	assert.deepEqual([...servers.keys()].sort(), ["docs", "ext", "inbox", "local"]);
	// A project entry without command/url only overrides enabled and keeps the rest.
	assert.equal(servers.get("inbox")?.config.enabled, false);
	assert.equal(servers.get("inbox")?.config.command, "inbox-mcp");
});

test("loadServers ignores the project file when the project is not trusted", () => {
	const { agentDir, cwd } = setup();
	const { servers } = loadServers({ agentDir, cwd, trusted: false });
	assert.deepEqual([...servers.keys()].sort(), ["docs", "inbox"]);
	assert.equal(servers.get("inbox")?.config.enabled, undefined);
});

test("mcp.json replaces a registered server with the same name, also across - and _", () => {
	const { agentDir, cwd } = setup();
	writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { my_srv: { command: "file" } } }));
	const { servers } = loadServers({ agentDir, cwd, trusted: false, registered: [{ name: "my-srv", config: { command: "ext" } }] });
	assert.deepEqual([...servers.keys()], ["my_srv"]);
	assert.equal(servers.get("my_srv")?.config.command, "file");
});

test("unsupportedReason skips OAuth, disabled and SSE servers", () => {
	assert.equal(unsupportedReason({ command: "x" }), undefined);
	assert.equal(unsupportedReason({ url: "https://x", headers: { Authorization: "Bearer y" } }), undefined);
	assert.match(unsupportedReason({ url: "https://x", oauth: { clientId: "c" } }) ?? "", /OAuth/);
	assert.equal(unsupportedReason({ command: "x", enabled: false }), "disabled");
	assert.match(unsupportedReason({ url: "https://x", type: "sse" }) ?? "", /SSE/);
});

test("resolveValue expands env vars, escapes and commands like pi", () => {
	const env = { TOKEN: "abc", USER_NAME: "pat" };
	assert.equal(resolveValue("Bearer ${TOKEN}", env), "Bearer abc");
	assert.equal(resolveValue("$USER_NAME-x", env), "pat-x");
	assert.equal(resolveValue("cost $$5 $!", env), "cost $5 !");
	assert.equal(resolveValue("!echo hi"), "hi");
	assert.throws(() => resolveValue("${MISSING_VAR_X}", env), /MISSING_VAR_X/);
});

test("subscription keys do not depend on argument order", () => {
	assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
	assert.equal(
		subscriptionKey({ server: "s", event: "e", arguments: { x: 1, y: 2 } }),
		subscriptionKey({ server: "s", event: "e", arguments: { y: 2, x: 1 } }),
	);
});

test("loadSubscriptions validates entries", () => {
	const { agentDir } = setup();
	writeFileSync(
		join(agentDir, "mcp-events.json"),
		JSON.stringify({
			subscriptions: [
				{ server: "inbox", event: "message.received", arguments: { include_text: true }, delivery: "poll" },
				{ server: "inbox" },
			],
		}),
	);
	const { subscriptions, errors } = loadSubscriptions(agentDir);
	assert.equal(subscriptions.length, 1);
	assert.deepEqual(subscriptions[0], {
		server: "inbox",
		event: "message.received",
		arguments: { include_text: true },
		delivery: "poll",
		maxAgeMs: undefined,
	});
	assert.equal(errors.length, 1);
});

test("ServerPool.resolveName accepts pi's mcp__ form and - or _", async () => {
	const { ServerPool } = await import("../src/subscription.ts");
	const servers = new Map([["my-inbox", { name: "my-inbox", config: { command: "x" }, source: "user" }]]);
	const pool = new ServerPool(servers, { cwd: "/", version: "t", log: () => {} });
	assert.equal(pool.resolveName("my-inbox"), "my-inbox");
	assert.equal(pool.resolveName("mcp__my_inbox"), "my-inbox");
	assert.equal(pool.resolveName("other"), undefined);
});
