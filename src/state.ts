// One locked, fsynced outbox per Pi session. Never import the legacy shared cursor file.
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stableStringify, type SubscriptionSpec } from "./config.ts";
import { formatPages } from "./format.ts";
import type { EventOccurrence } from "./subscription.ts";

export const limits = { pageChars: 64 * 1024, fileBytes: 16 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, files: 1024, pending: 4096, subscriptions: 128, seen: 200 };
export const identity = (value: unknown): string => createHash("sha256").update(stableStringify(value)).digest("hex");
export interface Receipt { id: string; key: string; server: string; event: string; content: string }
interface Entry { cursor: string | null; seen: string[]; spec?: SubscriptionSpec; active?: boolean }
interface Snapshot { version: 2; subscriptions: Record<string, Entry>; pending: Receipt[] }
const empty = (): Snapshot => ({ version: 2, subscriptions: {}, pending: [] });

/** SQLite supplies OS locks released on process death, without stale-PID reclaim races. */
function lock(path: string): () => void {
	const db = new DatabaseSync(path);
	try { db.exec("BEGIN EXCLUSIVE"); } catch (err) { db.close(); throw new Error("mcp-events state is busy; retry after its owner closes", { cause: err }); }
	return () => db.close();
}
export function syncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

export class StateStore {
	private committed: Snapshot;
	private staged?: Snapshot;
	private release?: () => void;
	readonly path: string;

	constructor(path: string) {
		this.path = path;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const unlock = lock(join(dirname(path), ".quota.sqlite"));
		try {
			if (!existsSync(`${path}.lock`) && readdirSync(dirname(path)).filter((f) => f.endsWith(".lock")).length >= limits.files) throw new Error("mcp-events session slots full; archive inactive state explicitly");
			this.release = lock(`${path}.lock`);
		} finally { unlock(); }
		try {
			// A prior interrupted atomic write is not committed. Its old cursor will replay.
			if (existsSync(`${path}.tmp`)) unlinkSync(`${path}.tmp`);
			if (existsSync(path) && statSync(path).size > limits.fileBytes) throw new Error("mcp-events state exceeds its size limit; preserve it for repair");
			this.committed = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : empty();
			if (this.committed.version !== 2 || !this.committed.subscriptions || !Array.isArray(this.committed.pending)) throw new Error("invalid mcp-events state; preserve the file and repair it before resuming");
		} catch (err) { this.close(); throw err; }
	}
	cursor(key: string): string | null { return this.committed.subscriptions[key]?.cursor ?? null; }
	hasSeen(key: string, eventId: string): boolean {
		return !!this.committed.subscriptions[key]?.seen.includes(eventId) || this.pending.some((r) => r.key === key && r.id.startsWith(`${identity(eventId)}:`));
	}
	get pending(): readonly Receipt[] { return this.committed.pending; }
	get intents(): [string, SubscriptionSpec][] {
		return Object.entries(this.committed.subscriptions).filter(([, e]) => e.active && e.spec).map(([k, e]) => [k, e.spec!]);
	}
	setIntent(key: string, spec: SubscriptionSpec, active: boolean): void {
		this.change((next) => { const e = this.entry(next, key); e.spec = spec; e.active = active; }, true);
	}
	/** Cursor, dedupe and full pages share one commit, before anything enters Pi's volatile queue. */
	accept(key: string, spec: SubscriptionSpec, events: EventOccurrence[], gap: boolean, cursor?: string | null): Receipt[] {
		const added: Receipt[] = [];
		this.change((next) => {
			const e = this.entry(next, key);
			const fresh: EventOccurrence[] = [];
			for (const event of events) {
				if (!event || typeof event.eventId !== "string") throw new Error("invalid MCP event; cursor not advanced");
				if (e.seen.includes(event.eventId) || next.pending.some((r) => r.key === key && r.id.startsWith(`${identity(event.eventId)}:`))) continue;
				fresh.push(event);
				e.seen.push(event.eventId);
			}
			for (const event of fresh) {
				for (const content of formatPages(spec.server, spec.event, [event], false)) {
					if (content.length > limits.pageChars) throw new Error("MCP event metadata exceeds the page limit; event not accepted; cursor not advanced");
					added.push({ id: `${identity(event.eventId)}:${randomUUID()}`, key, server: spec.server, event: spec.event, content });
				}
			}
			if (gap) added.push({ id: randomUUID(), key, server: spec.server, event: spec.event, content: formatPages(spec.server, spec.event, [], true)[0] });
			next.pending.push(...added);
			e.seen = e.seen.slice(-limits.seen);
			e.cursor = typeof cursor === "string" ? cursor : null;
		});
		return added;
	}
	acknowledge(ids: ReadonlySet<string>): void {
		if (!this.pending.some((r) => ids.has(r.id))) return;
		this.change((next) => { next.pending = next.pending.filter((r) => !ids.has(r.id)); }, true);
	}
	/** Failure preserves staged state. A later flush retries the same write. */
	flush(): void {
		if (!this.staged) return;
		const data = `${JSON.stringify(this.staged)}\n`;
		const bytes = Buffer.byteLength(data);
		if (bytes > limits.fileBytes || this.staged.pending.length > limits.pending || Object.keys(this.staged.subscriptions).length > limits.subscriptions) throw new Error("mcp-events session quota full; pending events retained; pause source or consume pending pages");
		const root = dirname(this.path);
		const unlock = lock(join(root, ".quota.sqlite"));
		try {
			const files = readdirSync(root).filter((f) => f.endsWith(".json") || f.endsWith(".json.tmp"));
			const oldBytes = existsSync(this.path) ? statSync(this.path).size : 0;
			const tempBytes = existsSync(`${this.path}.tmp`) ? statSync(`${this.path}.tmp`).size : 0;
			const total = files.reduce((sum, f) => sum + statSync(join(root, f)).size, 0);
			if ((bytes > oldBytes && total - oldBytes - tempBytes + bytes > limits.totalBytes) || total - tempBytes + bytes > limits.totalBytes + limits.fileBytes) throw new Error("mcp-events disk quota full; no pending events evicted; archive inactive session state explicitly");
			const fd = openSync(`${this.path}.tmp`, "w", 0o600);
			try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
			renameSync(`${this.path}.tmp`, this.path);
			syncDirectory(root);
			this.committed = this.staged;
			this.staged = undefined;
		} finally { unlock(); }
	}
	close(): void { this.release?.(); this.release = undefined; }
	private change(fn: (next: Snapshot) => void, replaceUncommitted = false): void {
		// Cleanup/stop may replace a failed, unaccepted transaction to relieve backpressure.
		if (!replaceUncommitted) this.flush();
		const next = structuredClone(this.committed);
		fn(next);
		this.staged = next;
		this.flush();
	}
	private entry(next: Snapshot, key: string): Entry {
		return (next.subscriptions[key] ??= { cursor: null, seen: [] });
	}
}
