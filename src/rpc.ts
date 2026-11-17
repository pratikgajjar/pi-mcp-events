// A small MCP JSON-RPC client for stdio and Streamable HTTP.
// It supports custom methods (events/*) and routes every server
// notification to listeners, which the MCP SDK client does not do cleanly.

import { type ChildProcess, spawn } from "node:child_process";

export interface RpcMessage {
	jsonrpc: "2.0";
	id?: number | string;
	method?: string;
	params?: any;
	result?: any;
	error?: { code: number; message: string; data?: unknown };
}

export class RpcError extends Error {
	readonly code: number;
	readonly data?: unknown;
	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
	}
}

export interface Transport {
	readonly kind: "stdio" | "http";
	/** Start the transport. `onMessage` gets every message from the server. */
	start(onMessage: (msg: RpcMessage) => void, onClose: (err?: Error) => void): Promise<void>;
	/**
	 * Send one message. For HTTP the promise settles when the response body ends,
	 * so a request whose stream ended without a result can be detected.
	 */
	send(msg: RpcMessage, signal?: AbortSignal): Promise<void>;
	close(): Promise<void>;
}

// ---------------------------------------------------------------- stdio

export interface StdioOptions {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export class StdioTransport implements Transport {
	readonly kind = "stdio";
	private child?: ChildProcess;
	private stderrTail = "";
	private closed = false;
	private readonly opts: StdioOptions;

	constructor(opts: StdioOptions) {
		this.opts = opts;
	}

	start(onMessage: (msg: RpcMessage) => void, onClose: (err?: Error) => void): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = spawn(this.opts.command, this.opts.args ?? [], {
				cwd: this.opts.cwd,
				env: { ...process.env, ...this.opts.env },
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32", // own process group, so stop() reaches wrappers like npx
			});
			this.child = child;
			let buffer = "";
			child.stdout!.setEncoding("utf8");
			child.stdout!.on("data", (chunk: string) => {
				buffer += chunk;
				let nl: number;
				while ((nl = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					if (!line) continue;
					try {
						onMessage(JSON.parse(line));
					} catch {
						// not JSON: ignore log noise on stdout
					}
				}
			});
			child.stderr!.setEncoding("utf8");
			child.stderr!.on("data", (chunk: string) => {
				this.stderrTail = (this.stderrTail + chunk).slice(-2000);
			});
			child.once("spawn", () => resolve());
			child.once("error", (err) => {
				reject(err);
				if (!this.closed) onClose(err);
			});
			child.once("exit", (code, sig) => {
				if (this.closed) return onClose();
				const tail = this.stderrTail.trim().split("\n").slice(-3).join(" | ");
				onClose(new Error(`server exited (${sig ?? code})${tail ? `: ${tail}` : ""}`));
			});
		});
	}

	async send(msg: RpcMessage): Promise<void> {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed) throw new Error("server stdin is closed");
		await new Promise<void>((resolve, reject) =>
			stdin.write(`${JSON.stringify(msg)}\n`, (err) => (err ? reject(err) : resolve())),
		);
	}

	async close(): Promise<void> {
		if (this.closed || !this.child) return;
		this.closed = true;
		const child = this.child;
		child.stdin?.end();
		const kill = (sig: NodeJS.Signals) => {
			try {
				if (child.pid && process.platform !== "win32") process.kill(-child.pid, sig);
				else child.kill(sig);
			} catch {
				// already gone
			}
		};
		if (child.exitCode !== null || child.signalCode !== null) return;
		kill("SIGTERM");
		const timer = setTimeout(() => kill("SIGKILL"), 2000);
		timer.unref();
		child.once("exit", () => clearTimeout(timer));
	}
}

// ---------------------------------------------------------------- Streamable HTTP

/** Parse an SSE byte stream into the `data` of each event. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let buffer = "";
	let data: string[] = [];
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let nl: number;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl).replace(/\r$/, "");
				buffer = buffer.slice(nl + 1);
				if (line === "") {
					if (data.length) yield data.join("\n");
					data = [];
				} else if (line.startsWith("data:")) {
					data.push(line.slice(5).replace(/^ /, ""));
				}
			}
		}
		const last = buffer.replace(/\r$/, "");
		if (last.startsWith("data:")) data.push(last.slice(5).replace(/^ /, ""));
		if (data.length) yield data.join("\n");
	} finally {
		reader.releaseLock();
	}
}

export class OAuthRequiredError extends Error {}

export class HttpTransport implements Transport {
	readonly kind = "http";
	sessionId?: string;
	protocolVersion?: string;
	private onMessage: (msg: RpcMessage) => void = () => {};
	private onClose: (err?: Error) => void = () => {};
	private readonly aborts = new Set<AbortController>();
	private readonly url: string;
	private readonly headers: Record<string, string>;

	constructor(url: string, headers: Record<string, string> = {}) {
		this.url = url;
		this.headers = headers;
	}

	async start(onMessage: (msg: RpcMessage) => void, onClose: (err?: Error) => void): Promise<void> {
		this.onMessage = onMessage;
		this.onClose = onClose;
	}

	async send(msg: RpcMessage, signal?: AbortSignal): Promise<void> {
		const headers: Record<string, string> = {
			...this.headers,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		};
		if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
		if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion;
		if (msg.method) headers["mcp-method"] = msg.method;
		// SEP-3415 routing header: the event name of events/* requests.
		const name = msg.params?.name;
		if (msg.method?.startsWith("events/") && typeof name === "string" && /^[\x20-\x7e]*$/.test(name)) {
			headers["mcp-name"] = name;
		}
		const abort = new AbortController();
		const onAbort = () => abort.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		this.aborts.add(abort);
		try {
			const res = await fetch(this.url, {
				method: "POST",
				headers,
				body: JSON.stringify(msg),
				signal: abort.signal,
			});
			const sid = res.headers.get("mcp-session-id");
			if (sid) this.sessionId = sid;
			if (res.status === 401) {
				throw new OAuthRequiredError("HTTP 401: the server needs OAuth sign-in, which pi-mcp-events does not support");
			}
			if (res.status === 404 && this.sessionId) {
				const err = new Error("HTTP 404: the MCP session expired");
				this.onClose(err);
				throw err;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
			if (res.status === 202 || !res.body) return;
			const type = res.headers.get("content-type") ?? "";
			if (type.includes("text/event-stream")) {
				for await (const data of readSse(res.body)) {
					try {
						this.onMessage(JSON.parse(data));
					} catch {
						// ignore frames that are not JSON
					}
				}
			} else if (type.includes("application/json")) {
				const body = await res.json();
				for (const m of Array.isArray(body) ? body : [body]) this.onMessage(m);
			} else {
				await res.body.cancel();
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.aborts.delete(abort);
		}
	}

	async close(): Promise<void> {
		for (const a of this.aborts) a.abort();
		if (this.sessionId) {
			const headers: Record<string, string> = { ...this.headers, "mcp-session-id": this.sessionId };
			await fetch(this.url, { method: "DELETE", headers, signal: AbortSignal.timeout(2000) }).catch(() => {});
		}
		this.onClose();
	}
}

// ---------------------------------------------------------------- client

export const EVENTS_EXTENSION = "io.modelcontextprotocol/events";
export const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
export const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

interface Pending {
	resolve: (value: any) => void;
	reject: (err: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
	abort?: AbortController;
}

export interface RequestOptions {
	/** 0 disables the timeout (for long-lived events/stream). */
	timeoutMs?: number;
}

export class McpClient {
	capabilities: any = {};
	protocolVersion?: string;
	serverInfo: any = {};
	closed = false;
	closeError?: Error;
	private nextId = 1;
	private readonly pending = new Map<string, Pending>();
	private readonly listeners = new Set<(msg: RpcMessage) => void>();
	private readonly closeListeners = new Set<(err?: Error) => void>();
	readonly transport: Transport;
	private readonly defaultTimeoutMs: number;

	constructor(transport: Transport, defaultTimeoutMs = 60_000) {
		this.transport = transport;
		this.defaultTimeoutMs = defaultTimeoutMs;
	}

	async connect(clientVersion: string): Promise<void> {
		await this.transport.start(
			(msg) => this.dispatch(msg),
			(err) => this.handleClose(err),
		);
		const init = await this.request("initialize", {
			protocolVersion: "2025-11-25",
			capabilities: { extensions: { [EVENTS_EXTENSION]: {} } },
			clientInfo: { name: "pi-mcp-events", version: clientVersion },
		});
		this.capabilities = init?.capabilities ?? {};
		this.serverInfo = init?.serverInfo ?? {};
		if (this.transport instanceof HttpTransport) this.transport.protocolVersion = init?.protocolVersion;
		this.protocolVersion = init?.protocolVersion;
		await this.notify("notifications/initialized");
	}

	/** The events capability: the SEP-3415 `extensions` entry. */
	get eventsCapability(): Record<string, unknown> | undefined {
		return this.capabilities?.extensions?.[EVENTS_EXTENSION];
	}

	onNotification(fn: (msg: RpcMessage) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	onClose(fn: (err?: Error) => void): () => void {
		this.closeListeners.add(fn);
		return () => this.closeListeners.delete(fn);
	}

	/** Send a request and return its id at once, so notifications can be matched to it. */
	start(method: string, params?: unknown, opts: RequestOptions = {}): { id: number; done: Promise<any> } {
		const id = this.nextId++;
		const key = String(id);
		const done = new Promise<any>((resolve, reject) => {
			if (this.closed) return reject(this.closeError ?? new Error("connection closed"));
			const p: Pending = { resolve, reject };
			const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
			if (timeoutMs > 0) {
				p.timer = setTimeout(() => this.settle(key, new Error(`${method} timed out after ${timeoutMs} ms`)), timeoutMs);
			}
			if (this.transport.kind === "http") p.abort = new AbortController();
			this.pending.set(key, p);
			this.transport
				.send({ jsonrpc: "2.0", id, method, params }, p.abort?.signal)
				.then(() => {
					// An HTTP response body ended without the result.
					if (this.transport.kind === "http") this.settle(key, new Error(`${method}: stream closed without a result`));
				})
				.catch((err) => this.settle(key, err instanceof Error ? err : new Error(String(err))));
		});
		return { id, done };
	}

	request(method: string, params?: unknown, opts?: RequestOptions): Promise<any> {
		return this.start(method, params, opts).done;
	}

	async notify(method: string, params?: unknown): Promise<void> {
		await this.transport.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
	}

	/** Cancel a request: notifications/cancelled on stdio, abort the request stream on HTTP. */
	cancel(id: number, reason: string): void {
		const p = this.pending.get(String(id));
		if (!p) return;
		if (p.abort) p.abort.abort();
		else this.notify("notifications/cancelled", { requestId: id, reason }).catch(() => {});
		this.settle(String(id), undefined, undefined, true);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		await this.transport.close().catch(() => {});
		this.handleClose();
	}

	private settle(key: string, err?: Error, result?: unknown, silent = false): void {
		const p = this.pending.get(key);
		if (!p) return;
		this.pending.delete(key);
		if (p.timer) clearTimeout(p.timer);
		if (silent) p.resolve(undefined);
		else if (err) p.reject(err);
		else p.resolve(result);
	}

	private dispatch(msg: RpcMessage): void {
		if (msg.id !== undefined && msg.method === undefined) {
			const key = String(msg.id);
			if (msg.error) this.settle(key, new RpcError(msg.error.code, msg.error.message, msg.error.data));
			else this.settle(key, undefined, msg.result);
			return;
		}
		if (msg.method && msg.id !== undefined) {
			// Server-to-client request: answer ping, refuse the rest.
			const reply: RpcMessage =
				msg.method === "ping"
					? { jsonrpc: "2.0", id: msg.id, result: {} }
					: { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } };
			this.transport.send(reply).catch(() => {});
			return;
		}
		if (msg.method) for (const fn of this.listeners) fn(msg);
	}

	private handleClose(err?: Error): void {
		if (this.closed) return;
		this.closed = true;
		this.closeError = err ?? new Error("connection closed");
		for (const key of [...this.pending.keys()]) this.settle(key, this.closeError);
		for (const fn of this.closeListeners) fn(err);
	}
}
