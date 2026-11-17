// message_end can precede append. Only on-disk, exact content plus fsync authorizes cleanup.
import { closeSync, fsyncSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { syncDirectory, type Receipt } from "./state.ts";

export function persistedReceipts(path: string | undefined, sessionId: string, pending: readonly Receipt[]): Set<string> {
	const found = new Set<string>();
	if (!path || !pending.length) return found;
	let fd: number;
	try { fd = openSync(path, "r"); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return found; throw err; }
	try {
		const expected = new Map(pending.map((r) => [r.id, r.content]));
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.alloc(64 * 1024);
		let line = "", skipping = false, header = false;
		for (;;) {
			const n = readSync(fd, buffer, 0, buffer.length, null);
			if (!n) break;
			for (const part of decoder.write(buffer.subarray(0, n)).split(/(?<=\n)/)) {
				if (!skipping) line += part;
				if (line.length > 1024 * 1024) { line = ""; skipping = true; }
				if (!part.endsWith("\n")) continue;
				if (!skipping) {
					try {
						const entry = JSON.parse(line);
						if (entry.type === "session") { if (entry.id !== sessionId) throw new Error("session identity mismatch"); header = true; }
						const id = entry.details?.receiptId;
						if (header && entry.type === "custom_message" && entry.customType === "mcp-event" && typeof id === "string" && expected.has(id) && expected.get(id) === entry.content) found.add(id);
					} catch (err) { if (!(err instanceof SyntaxError)) throw err; }
				}
				line = ""; skipping = false;
			}
		}
		if (found.size) { fsyncSync(fd); syncDirectory(dirname(path)); }
	} finally { closeSync(fd); }
	return found;
}
