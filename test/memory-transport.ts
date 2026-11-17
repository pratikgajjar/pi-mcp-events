// An in-memory transport for unit tests. `handle` plays the server side.

import type { RpcMessage, Transport } from "../src/rpc.ts";

export type Handler = (msg: RpcMessage, t: MemoryTransport) => void;

export class MemoryTransport implements Transport {
	readonly kind: "stdio" | "http";
	readonly sent: RpcMessage[] = [];
	private onMessage: (msg: RpcMessage) => void = () => {};
	private onClose: (err?: Error) => void = () => {};
	private readonly handle: Handler;

	constructor(handle: Handler, kind: "stdio" | "http" = "stdio") {
		this.handle = handle;
		this.kind = kind;
	}

	async start(onMessage: (msg: RpcMessage) => void, onClose: (err?: Error) => void): Promise<void> {
		this.onMessage = onMessage;
		this.onClose = onClose;
	}

	async send(msg: RpcMessage): Promise<void> {
		this.sent.push(msg);
		queueMicrotask(() => this.handle(msg, this));
	}

	/** Send a message from the server to the client. */
	emit(msg: Omit<RpcMessage, "jsonrpc">): void {
		this.onMessage({ jsonrpc: "2.0", ...msg });
	}

	/** Simulate the server process exiting. */
	die(err = new Error("server exited")): void {
		this.onClose(err);
	}

	async close(): Promise<void> {
		this.onClose();
	}
}

/** Answer initialize with the given capabilities. Returns true when handled. */
export function answerInit(msg: RpcMessage, t: MemoryTransport, capabilities: unknown): boolean {
	if (msg.method === "initialize") {
		t.emit({ id: msg.id, result: { protocolVersion: "2025-11-25", capabilities, serverInfo: { name: "test", version: "0" } } });
		return true;
	}
	return msg.method === "notifications/initialized";
}

export const EVENTS_CAPS = { extensions: { "io.modelcontextprotocol/events": {} } };

export function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
			setTimeout(tick, 5);
		};
		tick();
	});
}
