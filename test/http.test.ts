import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { HttpTransport, McpClient, OAuthRequiredError } from "../src/rpc.ts";
import { waitFor } from "./memory-transport.ts";

async function body(req: IncomingMessage): Promise<any> {
	let text = "";
	for await (const chunk of req) text += chunk;
	return text ? JSON.parse(text) : undefined;
}

test("Streamable HTTP: JSON and SSE responses, session id, Mcp-Name, abort on cancel", async () => {
	const seen: { method: string; headers: IncomingMessage["headers"] }[] = [];
	let streamClosed = false;
	const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
		if (req.method === "DELETE") return res.writeHead(200).end();
		const msg = await body(req);
		seen.push({ method: msg.method, headers: req.headers });
		if (msg.method === "initialize") {
			res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s-1" });
			return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: { extensions: { "io.modelcontextprotocol/events": {} } } } }));
		}
		if (msg.method === "events/stream") {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const meta = { "io.modelcontextprotocol/subscriptionId": msg.id };
			res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/events/active", params: { cursor: "c0", _meta: meta } })}\n\n`);
			res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/events/event", params: { eventId: "e1", name: "ev", data: {}, cursor: "c1", _meta: meta } })}\n\n`);
			res.on("close", () => (streamClosed = true));
			return; // keep the stream open
		}
		res.writeHead(202).end();
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
	try {
		const client = new McpClient(new HttpTransport(url, { "x-api-key": "k" }));
		await client.connect("test");
		assert.ok(client.eventsCapability);
		const notes: any[] = [];
		client.onNotification((m) => notes.push(m));
		const call = client.start("events/stream", { name: "ev", arguments: {}, cursor: null }, { timeoutMs: 0 });
		await waitFor(() => notes.length === 2);
		assert.equal(notes[1].params.eventId, "e1");
		const streamReq = seen.find((s) => s.method === "events/stream")!;
		assert.equal(streamReq.headers["mcp-session-id"], "s-1");
		assert.equal(streamReq.headers["mcp-name"], "ev");
		assert.equal(streamReq.headers["mcp-method"], "events/stream");
		assert.equal(streamReq.headers["mcp-protocol-version"], "2025-11-25");
		assert.equal(streamReq.headers["x-api-key"], "k");
		client.cancel(call.id, "done");
		await waitFor(() => streamClosed);
		assert.ok(!seen.some((s) => s.method === "notifications/cancelled"), "HTTP cancels by aborting, not by message");
		await client.close();
	} finally {
		server.close();
	}
});

test("Streamable HTTP: 401 is reported as an OAuth server", async () => {
	const server = createServer((_req, res) => res.writeHead(401).end());
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
	try {
		await assert.rejects(new McpClient(new HttpTransport(url)).connect("test"), OAuthRequiredError);
	} finally {
		server.close();
	}
});
