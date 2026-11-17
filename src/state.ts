// One locked, fsynced outbox per Pi session. Never import the legacy shared cursor file.
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stableStringify, type SubscriptionSpec } from "./config.ts";
import { formatPages } from "./format.ts";
import type { EventOccurrence } from "./subscription.ts";

export const limits = { pageChars: 64 * 1024, fileBytes: 16 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, files: 1024, freeAfterSweep: 64, quotaWaitMs: 10_000, pending: 4096, subscriptions: 128, seen: 200 };
export const identity = (value: unknown): string => createHash("sha256").update(stableStringify(value)).digest("hex");
export interface Receipt { id: string; key: string; server: string; event: string; content: string }
export type IntentSource = "config" | "runtime";
interface Entry { cursor: string | null; seen: string[]; spec?: SubscriptionSpec; active?: boolean; source?: IntentSource }
interface Snapshot { version: 2; subscriptions: Record<string, Entry>; pending: Receipt[] }
const empty = (): Snapshot => ({ version: 2, subscriptions: {}, pending: [] });

/**
 * retained: pending pages or a runtime (or 0.1.1) intent; it holds a session slot.
 * cursor: only config-subscription cursors; a closed one is evictable when slots fill.
 * empty: nothing to keep; close and sweeps delete it.
 */
export type StateKind = "retained" | "cursor" | "empty";
export function classify(s: Snapshot): StateKind {
	if (s.pending.length) return "retained";
	const active = Object.values(s.subscriptions).filter((e) => e.active && e.spec);
	if (active.some((e) => e.source !== "config")) return "retained";
	return active.some((e) => e.cursor !== null || e.seen.length) ? "cursor" : "empty";
}

/** SQLite supplies OS locks released on process death, without stale-PID reclaim races. */
function lock(path: string, waitMs = limits.quotaWaitMs): () => void {
	const db = new DatabaseSync(path, { timeout: waitMs });
	try { db.exec("BEGIN EXCLUSIVE"); } catch (err) { db.close(); throw new Error("mcp-events state is busy; retry after its owner closes", { cause: err }); }
	return () => db.close();
}
const quota = (root: string, waitMs?: number) => lock(join(root, ".quota.sqlite"), waitMs);
interface OwnerLock { release(unlink: boolean): void }
/**
 * Owner lock, never waiting: undefined means a live owner holds it. Callers must hold the quota lock,
 * so no process can open a lock file's old inode while another unlinks it.
 */
function tryLock(path: string): OwnerLock | undefined {
	const db = new DatabaseSync(path);
	try { db.exec("BEGIN EXCLUSIVE"); } catch (err) {
		db.close();
		if ((err as { errcode?: number }).errcode === 5 || /locked|busy/i.test(String(err))) return undefined;
		throw err;
	}
	return {
		release(unlink) {
			try { if (unlink) rmSync(path, { force: true }); }
			finally { db.close(); if (unlink) rmSync(`${path}-journal`, { force: true }); }
		},
	};
}
const remove = (path: string) => { try { unlinkSync(path); } catch {} };
const consumerName = (file: string) => file.endsWith(".json") ? file.slice(0, -5) : file.endsWith(".json.lock") ? file.slice(0, -10) : undefined;

/**
 * Removes lock files without state that no live owner holds, such as 0.1.1 leftovers. Returns the count.
 * Takes the quota lock only when such files exist. A full-slot sweep handles the rest.
 */
export function cleanStaleLocks(root: string, waitMs = 1000): number {
	if (!existsSync(root)) return 0;
	const candidates = (list: string[]) => { const files = new Set(list); return list.filter((f) => (f.endsWith(".json.lock") && !files.has(f.slice(0, -5))) || (f.endsWith(".json.lock-journal") && !files.has(f.slice(0, -8)))); };
	if (!candidates(readdirSync(root)).length) return 0;
	const unlock = quota(root, waitMs);
	let removed = 0;
	try {
		for (const name of candidates(readdirSync(root)).filter((f) => f.endsWith(".json.lock"))) {
			const file = join(root, name);
			let owner: OwnerLock | undefined;
			try { owner = tryLock(file); } catch { continue; }
			if (!owner) continue;
			owner.release(true);
			removed++;
		}
		// A journal without its lock file cannot belong to an owner: opening one needs the quota lock.
		for (const name of candidates(readdirSync(root))) if (name.endsWith("-journal")) remove(join(root, name));
	} finally { unlock(); }
	return removed;
}

/** Called under the quota lock for a consumer with no state file. Returns evicted cursor-only consumers. */
function admit(root: string, own: string): string[] {
	const others = new Set(readdirSync(root).map(consumerName).filter((n): n is string => !!n && n !== own));
	if (others.size < limits.files) return [];
	// Slots full by file count: classify each consumer while holding its owner lock.
	let real = 0;
	const idle: { name: string; mtime: number }[] = [];
	for (const name of others) {
		const path = join(root, `${name}.json`);
		let owner: OwnerLock | undefined;
		try { owner = tryLock(`${path}.lock`); } catch { real++; continue; }
		if (!owner) { real++; continue; }
		try {
			let kind: StateKind = "empty";
			if (existsSync(path)) {
				try { kind = statSync(path).size > limits.fileBytes ? "retained" : classify(JSON.parse(readFileSync(path, "utf8"))); }
				catch { kind = "retained"; } // corrupt or unreadable: preserve for repair
			}
			if (kind === "retained") real++;
			else if (kind === "cursor") idle.push({ name, mtime: statSync(path).mtimeMs });
			else { remove(path); remove(`${path}.tmp`); }
		} finally { owner.release(true); }
	}
	if (real >= limits.files) throw new Error(`mcp-events session slots full: ${real} sessions hold pending events or runtime subscriptions; consume or unsubscribe them, then retry`);
	// Oldest closed cursor-only state goes first; pending pages and runtime intents are never evicted.
	idle.sort((a, b) => a.mtime - b.mtime);
	const evicted = idle.slice(0, Math.max(0, real + idle.length - (limits.files - limits.freeAfterSweep))).map((e) => e.name);
	for (const name of evicted) { remove(join(root, `${name}.json`)); remove(join(root, `${name}.json.tmp`)); }
	if (evicted.length) syncDirectory(root);
	return evicted;
}
export function syncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try { fsyncSync(fd); } finally { closeSync(fd); }
}

export class StateStore {
	private committed: Snapshot = empty();
	private staged?: Snapshot;
	private owner?: OwnerLock;
	readonly path: string;
	/** Closed sessions' cursor-only state removed to admit this one. */
	readonly evicted: string[] = [];

	constructor(path: string) {
		this.path = path;
		const root = dirname(path);
		mkdirSync(root, { recursive: true, mode: 0o700 });
		// Acquire and release-with-unlink both run under the quota lock: no stale-inode owners.
		const unlock = quota(root);
		try {
			this.owner = tryLock(`${path}.lock`);
			if (!this.owner) throw new Error("mcp-events state is busy; retry after its owner closes");
			try { if (!existsSync(path)) this.evicted.push(...admit(root, basename(path, ".json"))); }
			catch (err) { this.owner.release(true); this.owner = undefined; throw err; }
		} finally { unlock(); }
		try {
			// A prior interrupted atomic write is not committed. Its old cursor will replay.
			if (existsSync(`${path}.tmp`)) unlinkSync(`${path}.tmp`);
			if (existsSync(path) && statSync(path).size > limits.fileBytes) throw new Error("mcp-events state exceeds its size limit; preserve it for repair");
			const loaded = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : empty();
			if (loaded?.version !== 2 || !loaded.subscriptions || !Array.isArray(loaded.pending)) throw new Error("invalid mcp-events state; preserve the file and repair it before resuming");
			this.committed = loaded;
		} catch (err) { this.close(false); throw err; }
	}
	cursor(key: string): string | null { return this.committed.subscriptions[key]?.cursor ?? null; }
	hasSeen(key: string, eventId: string): boolean {
		return !!this.committed.subscriptions[key]?.seen.includes(eventId) || this.pending.some((r) => r.key === key && r.id.startsWith(`${identity(eventId)}:`));
	}
	get pending(): readonly Receipt[] { return this.committed.pending; }
	/** Active intents. Entries from 0.1.1 have no source and count as runtime intents. */
	get intents(): { key: string; spec: SubscriptionSpec; source: IntentSource }[] {
		return Object.entries(this.committed.subscriptions).filter(([, e]) => e.active && e.spec).map(([key, e]) => ({ key, spec: e.spec!, source: e.source ?? "runtime" }));
	}
	setIntent(key: string, spec: SubscriptionSpec, active: boolean, source?: IntentSource): void {
		this.change((next) => {
			const e = this.entry(next, key);
			// A config subscription never downgrades an active runtime intent.
			if (source && !(source === "config" && e.active && e.source === "runtime")) e.source = source;
			e.spec = spec; e.active = active;
		}, true);
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
	/**
	 * Never throws. Removes the lock file, and the state file when nothing in it needs keeping.
	 * cleanup=false (failed open) keeps the state file for repair.
	 */
	close(cleanup = true): void {
		const owner = this.owner;
		if (!owner) return;
		this.owner = undefined;
		let unlock: (() => void) | undefined;
		try { unlock = quota(dirname(this.path)); } catch { owner.release(false); return; } // a later sweep removes the lock file
		try {
			remove(`${this.path}.tmp`);
			if (cleanup && classify(this.committed) === "empty" && existsSync(this.path)) { unlinkSync(this.path); syncDirectory(dirname(this.path)); }
		} catch {
			// keep state on unexpected errors; the lock is still released below
		} finally {
			owner.release(true);
			unlock();
		}
	}
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
