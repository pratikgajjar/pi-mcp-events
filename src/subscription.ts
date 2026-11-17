// Server connections and the poll / push loops of SEP-3415.

import { expandHome, resolveCwd, resolveRecord, type ServerEntry, type SubscriptionSpec, subscriptionKey, unsupportedReason } from "./config.ts";
import { CLIENT_CAPABILITIES, EVENTS_EXTENSION, HttpTransport, McpClient, OAuthRequiredError, RpcError, type RpcMessage, StdioTransport, SUBSCRIPTION_ID, type Transport } from "./rpc.ts";
import type { StateStore } from "./state.ts";

export interface EventDescriptor {
	name: string;
	description?: string;
	delivery?: string[];
	inputSchema?: unknown;
	payloadSchema?: unknown;
}

export interface EventOccurrence {
	eventId: string;
	name: string;
	timestamp?: string;
	data?: unknown;
	cursor?: string | null;
}

/** Poll interval when the server sends no nextPollMs. */
const DEFAULT_POLL_MS = 5000;

/** Timing constants. Tests make them shorter. */
export const timing = {
	/** Floor for nextPollMs (SEP-3415 default). */
	pollFloorMs: 1000,
	/** Expected heartbeat interval when the server grants none. */
	heartbeatMs: 30_000,
	maxBackoffMs: 30_000,
	retryBaseMs: 1000,
};
// Errors that will not go away on retry (SEP-3415 codes, and the -32011.. codes of earlier drafts).
const TERMINAL_CODES = new Set([-32601, -32602, -32023, -32024, -32026, -32011, -32012, -32014]);

/** An error that ends a subscription: retrying cannot fix it. */
export class TerminalError extends Error {}

/** The server changed the event's schema in place: list events again and resubscribe. */
class SchemaChangedError extends Error {}

function isTerminal(e: Error): boolean {
	return e instanceof TerminalError || e instanceof OAuthRequiredError || (e instanceof RpcError && TERMINAL_CODES.has(e.code));
}

export interface PoolOptions {
	cwd: string;
	version: string;
	log: (line: string) => void;
	/** Build the transport for a server. Default: stdio or Streamable HTTP from its config. */
	makeTransport?: (entry: ServerEntry) => Transport;
}

export class ServerPool {
	servers: Map<string, ServerEntry>;
	private readonly opts: PoolOptions;
	private readonly clients = new Map<string, Promise<McpClient>>();
	private readonly eventLists = new WeakMap<McpClient, Promise<EventDescriptor[]>>();

	constructor(servers: Map<string, ServerEntry>, opts: PoolOptions) {
		this.servers = servers;
		this.opts = opts;
	}

	/**
	 * The configured name for a name the model gives. Accepts pi's namespace
	 * form (`mcp__name`) and treats `-` and `_` as the same, as pi does.
	 */
	resolveName(name: string): string | undefined {
		if (this.servers.has(name)) return name;
		const norm = (n: string) => n.replace(/^mcp__/, "").replace(/-/g, "_");
		return [...this.servers.keys()].find((k) => norm(k) === norm(name));
	}

	entry(name: string): ServerEntry {
		const entry = this.servers.get(name);
		if (!entry) {
			const known = [...this.servers.keys()].join(", ") || "none";
			throw new TerminalError(`no MCP server named "${name}" (configured: ${known})`);
		}
		const reason = unsupportedReason(entry.config);
		if (reason) throw new TerminalError(`MCP server "${name}": ${reason}`);
		return entry;
	}

	get(name: string): Promise<McpClient> {
		const existing = this.clients.get(name);
		if (existing) return existing;
		const promise = this.connect(name);
		this.clients.set(name, promise);
		promise.then(
			(client) => client.onClose(() => this.clients.get(name) === promise && this.clients.delete(name)),
			() => this.clients.get(name) === promise && this.clients.delete(name),
		);
		return promise;
	}

	async events(name: string): Promise<EventDescriptor[]> {
		const client = await this.get(name);
		let list = this.eventLists.get(client);
		if (!list) {
			list = (async () => {
				const all: EventDescriptor[] = [];
				let cursor: string | undefined;
				do {
					const res = await client.request("events/list", cursor ? { cursor } : {});
					all.push(...(res?.events ?? []));
					cursor = res?.nextCursor ?? undefined;
				} while (cursor);
				return all;
			})();
			list.catch(() => this.eventLists.delete(client));
			this.eventLists.set(client, list);
		}
		return list;
	}

	/** Forget the cached events/list after notifications/events/list_changed. */
	invalidate(client: McpClient | undefined): void {
		if (client) this.eventLists.delete(client);
	}

	async close(name: string): Promise<void> {
		const p = this.clients.get(name);
		this.clients.delete(name);
		if (p) await p.then((c) => c.close()).catch(() => {});
	}

	async closeAll(): Promise<void> {
		await Promise.all([...this.clients.keys()].map((n) => this.close(n)));
	}

	private defaultTransport(entry: ServerEntry): Transport {
		const { config } = entry;
		if (config.url) return new HttpTransport(config.url, resolveRecord(config.headers));
		return new StdioTransport({
			command: expandHome(config.command!),
			args: config.args?.map(expandHome),
			env: resolveRecord(config.env),
			cwd: resolveCwd(this.opts.cwd, config.cwd),
		});
	}

	private async connect(name: string): Promise<McpClient> {
		const entry = this.entry(name);
		const timeoutMs = (entry.config.timeout ?? 60) * 1000;
		const transport = (this.opts.makeTransport ?? ((e) => this.defaultTransport(e)))(entry);
		const client = new McpClient(transport, timeoutMs);
		const log = this.opts.log;
		try {
			await client.connect(this.opts.version);
		} catch (err) {
			await client.close();
			throw err;
		}
		client.onNotification((m) => m.method === "notifications/events/list_changed" && this.invalidate(client));
		client.onClose((err) => log(`[${name}] connection closed${err ? `: ${err.message}` : ""}`));
		if (!client.eventsCapability) {
			await client.close();
			throw new TerminalError(`MCP server "${name}" does not advertise MCP Events`);
		}
		log(`[${name}] connected (${transport.kind})`);
		return client;
	}
}

export type Deliver = (sub: Subscription, events: EventOccurrence[], gap: boolean) => void;

export type SubStatus = "starting" | "active" | "retrying" | "failed" | "stopped";

export class Subscription {
	readonly key: string;
	status: SubStatus = "starting";
	mode?: "push" | "poll";
	lastError?: string;
	delivered = 0;
	readonly ready: Promise<void>;
	private markReady!: () => void;
	private markFailed!: (err: Error) => void;
	private stopped = false;
	private gap = false;
	private heartbeatMs?: number;
	private cancelCurrent?: () => void;
	private wake?: () => void;
	readonly spec: SubscriptionSpec;
	readonly source: "config" | "runtime";
	private readonly pool: ServerPool;
	private readonly state: StateStore;
	private readonly deliver: Deliver;
	private readonly log: (line: string) => void;
	private readonly onChange: () => void;
	private readonly onEnd: (err: Error) => void;

	constructor(opts: {
		spec: SubscriptionSpec;
		source: "config" | "runtime";
		pool: ServerPool;
		state: StateStore;
		deliver: Deliver;
		log: (line: string) => void;
		onChange?: () => void;
		/** Called once when the subscription fails for good (terminated, unknown event, ...). */
		onEnd?: (err: Error) => void;
	}) {
		this.spec = opts.spec;
		this.source = opts.source;
		this.pool = opts.pool;
		this.state = opts.state;
		this.deliver = opts.deliver;
		this.log = opts.log;
		this.onChange = opts.onChange ?? (() => {});
		this.onEnd = opts.onEnd ?? (() => {});
		this.key = subscriptionKey(opts.spec);
		this.ready = new Promise((resolve, reject) => {
			this.markReady = resolve;
			this.markFailed = reject;
		});
		this.ready.catch(() => {});
	}

	get label(): string {
		const args = Object.keys(this.spec.arguments).length ? ` ${JSON.stringify(this.spec.arguments)}` : "";
		return `${this.spec.server}/${this.spec.event}${args}`;
	}

	start(): void {
		void this.run();
	}

	stop(): void {
		this.stopped = true;
		this.cancelCurrent?.();
		this.wake?.();
		this.setStatus("stopped");
	}

	private setStatus(status: SubStatus, error?: string): void {
		if (this.status === "stopped") return;
		this.status = status;
		if (error !== undefined) this.lastError = error;
		if (status === "active") this.markReady();
		this.onChange();
	}

	private async run(): Promise<void> {
		let failures = 0;
		while (!this.stopped) {
			try {
				const client = await this.pool.get(this.spec.server);
				if (!this.mode) this.mode = await this.chooseMode();
				if (this.mode === "push") await this.push(client);
				else await this.poll(client);
				failures = 0; // the server ended the stream cleanly: reconnect
				await this.sleep(500 + Math.random() * 1000);
			} catch (err) {
				if (this.stopped) break;
				const e = err instanceof Error ? err : new Error(String(err));
				if (isTerminal(e)) {
					const msg = e instanceof RpcError ? `${e.message} (${e.code})` : e.message;
					this.log(`[${this.label}] failed: ${msg}`);
					this.setStatus("failed", msg);
					this.markFailed(e);
					this.onEnd(e);
					return;
				}
				if (e instanceof SchemaChangedError) {
					// SEP-3415: re-fetch events/list and resubscribe against the current descriptor.
					this.log(`[${this.label}] ${e.message}; listing events again`);
					this.pool.invalidate(await this.pool.get(this.spec.server).catch(() => undefined));
					this.mode = undefined;
					continue;
				}
				failures++;
				const delay = Math.min(timing.maxBackoffMs, timing.retryBaseMs * 2 ** Math.min(failures - 1, 5)) * (0.75 + Math.random() / 2);
				this.log(`[${this.label}] ${e.message}; retry in ${Math.round(delay / 1000)} s`);
				this.setStatus("retrying", e.message);
				if (failures >= 3) this.markFailed(e); // the tool call stops waiting; the loop keeps trying
				await this.sleep(delay);
			}
		}
	}

	private async chooseMode(): Promise<"push" | "poll"> {
		const events = await this.pool.events(this.spec.server);
		const desc = events.find((e) => e.name === this.spec.event);
		if (!desc) throw new TerminalError(`MCP server "${this.spec.server}" has no event "${this.spec.event}"`);
		const offered = desc.delivery ?? ["poll"];
		const wanted = this.spec.delivery;
		if (wanted && !offered.includes(wanted)) {
			throw new TerminalError(`event "${desc.name}" does not offer ${wanted} delivery (offers ${offered.join(", ")})`);
		}
		if (wanted) return wanted;
		if (offered.includes("push")) return "push";
		if (offered.includes("poll")) return "poll";
		throw new TerminalError(`event "${desc.name}" offers only ${offered.join(", ")}; pi-mcp-events supports push and poll`);
	}

	private requestParams(): Record<string, unknown> {
		const cursor = this.state.cursor(this.key);
		const params: Record<string, unknown> = {
			name: this.spec.event,
			arguments: this.spec.arguments,
			cursor,
			// SEP-3415 per-request client capabilities: this client understands the events extension.
			_meta: { [CLIENT_CAPABILITIES]: { extensions: { [EVENTS_EXTENSION]: {} } } },
		};
		if (cursor && this.spec.maxAgeMs) params.maxAgeMs = this.spec.maxAgeMs;
		return params;
	}

	private handle(events: EventOccurrence[]): void {
		const fresh = events.filter((e) => e && typeof e.eventId === "string" && this.state.firstSeen(this.key, e.eventId));
		if (fresh.length === 0) return;
		this.delivered += fresh.length;
		this.log(`[${this.label}] ${fresh.length} event(s): ${fresh.map((e) => e.eventId).join(", ")}`);
		this.deliver(this, fresh, this.gap);
		this.gap = false;
		this.onChange();
	}

	private async poll(client: McpClient): Promise<void> {
		while (!this.stopped && !client.closed) {
			const res = await client.request("events/poll", this.requestParams());
			if (this.stopped) return;
			if (res?.truncated) this.gap = true;
			this.handle(res?.events ?? []);
			this.state.setCursor(this.key, res?.cursor);
			this.setStatus("active", "");
			const next = typeof res?.nextPollMs === "number" ? res.nextPollMs : DEFAULT_POLL_MS;
			const wait = res?.hasMore ? 0 : Math.max(timing.pollFloorMs, next);
			await this.sleep(wait);
		}
		if (client.closed) throw client.closeError ?? new Error("connection closed");
	}

	private push(client: McpClient): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const call = client.start("events/stream", { ...this.requestParams(), heartbeatMs: timing.heartbeatMs }, { timeoutMs: 0 });
			const finish = (err?: Error) => {
				if (timer) clearTimeout(timer);
				off();
				this.cancelCurrent = undefined;
				if (err) reject(err);
				else resolve();
			};
			// No event or heartbeat for 2x the heartbeat interval (3x a granted heartbeatMs): the stream is dead.
			const arm = () => {
				if (timer) clearTimeout(timer);
				const limit = this.heartbeatMs ? Math.max(3 * this.heartbeatMs, 2 * timing.heartbeatMs) : 2 * timing.heartbeatMs;
				timer = setTimeout(() => {
					client.cancel(call.id, "no heartbeat");
					finish(new Error(`no event or heartbeat for ${limit / 1000} s; reconnecting`));
				}, limit);
			};
			const off = client.onNotification((m: RpcMessage) => {
				if (!m.method?.startsWith("notifications/events/")) return;
				if (String(m.params?._meta?.[SUBSCRIPTION_ID]) !== String(call.id)) return;
				arm();
				const p = m.params ?? {};
				switch (m.method) {
					case "notifications/events/active":
						if (typeof p.heartbeatMs === "number") this.heartbeatMs = p.heartbeatMs;
						if (p.truncated) this.gap = true;
						this.state.setCursor(this.key, p.cursor);
						this.setStatus("active", "");
						arm();
						break;
					case "notifications/events/heartbeat":
						this.state.setCursor(this.key, p.cursor);
						break;
					case "notifications/events/event":
						this.handle([p]);
						this.state.setCursor(this.key, p.cursor);
						break;
					case "notifications/events/error":
						this.log(`[${this.label}] server error: ${p.error?.message ?? "unknown"}`);
						break;
					case "notifications/events/terminated":
						client.cancel(call.id, "terminated");
						if (p.error?.code === -32026 && p.error?.data?.reason === "schema_changed") {
							finish(new SchemaChangedError(`event schema changed (${p.error?.data?.feature ?? "schema"})`));
						} else {
							finish(new TerminalError(`terminated by server: ${p.error?.message ?? "no reason"} (${p.error?.code})`));
						}
						break;
				}
			});
			this.cancelCurrent = () => {
				client.cancel(call.id, "unsubscribed");
				finish();
			};
			arm();
			call.done.then(
				() => finish(),
				(err) => finish(err),
			);
		});
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const t = setTimeout(done, ms);
			function done() {
				clearTimeout(t);
				resolve();
			}
			this.wake = done;
		});
	}
}
