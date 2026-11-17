// Cursors and recent event ids per subscription, kept in mcp-events-state.json.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const SEEN_LIMIT = 200;

interface Entry {
	cursor: string | null;
	seen: string[];
	updatedAt: string;
}

export class StateStore {
	private entries: Record<string, Entry> = {};
	private dirty = new Set<string>();
	private timer?: ReturnType<typeof setTimeout>;
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
		this.entries = this.readFile();
	}

	cursor(key: string): string | null {
		return this.entries[key]?.cursor ?? null;
	}

	setCursor(key: string, cursor: string | null | undefined): void {
		const e = this.entry(key);
		// SEP-3415: absent means null; a null cursor is never replayed.
		const next = typeof cursor === "string" ? cursor : null;
		if (e.cursor === next) return;
		e.cursor = next;
		this.touch(key);
	}

	/** True the first time an eventId is seen for this subscription. */
	firstSeen(key: string, eventId: string): boolean {
		const e = this.entry(key);
		if (e.seen.includes(eventId)) return false;
		e.seen.push(eventId);
		if (e.seen.length > SEEN_LIMIT) e.seen.splice(0, e.seen.length - SEEN_LIMIT);
		this.touch(key);
		return true;
	}

	/** Write pending changes now. Other pi processes may share the file, so merge by key. */
	flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.dirty.size === 0) return;
		const merged = this.readFile();
		for (const key of this.dirty) merged[key] = this.entries[key];
		this.dirty.clear();
		mkdirSync(dirname(this.path), { recursive: true });
		const tmp = `${this.path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ version: 1, subscriptions: merged }, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, this.path);
	}

	private entry(key: string): Entry {
		return (this.entries[key] ??= { cursor: null, seen: [], updatedAt: new Date().toISOString() });
	}

	private touch(key: string): void {
		this.entries[key].updatedAt = new Date().toISOString();
		this.dirty.add(key);
		this.timer ??= setTimeout(() => {
			try {
				this.flush();
			} catch {
				// keep state in memory; the next flush retries
			}
		}, 500);
	}

	private readFile(): Record<string, Entry> {
		if (!existsSync(this.path)) return {};
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8"));
			return parsed?.subscriptions && typeof parsed.subscriptions === "object" ? parsed.subscriptions : {};
		} catch {
			return {};
		}
	}
}
