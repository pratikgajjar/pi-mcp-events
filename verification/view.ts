// Statechart view; sets arrive as arrays. Flush-only steps stay inside a chart state.
export const title = "Accepted pages remain recoverable";
export const state = (v: any) => !v.accepted.length
	? v.stopped ? "Stopped, no input" : v.phase === "connecting" ? "Connecting" : v.phase === "mode" ? "Choosing delivery" : "Listening"
	: !v.pending.length ? "Persisted, cleaned" : v.stopped ? "Stopped, pending retained" : v.persisted.length ? "Synced, pending cleanup" : v.appended.length ? "Appended, not synced" : v.queued.length ? "Queued, not persisted" : "Saved in outbox";
export const step = (action: string) => ({
	ConnectionReturns: "connection returns", ModeReturnsAndStreamStarts: "delivery chosen", AcceptAndSaveOutbox: "save complete page and cursor",
	QueuePage: "enqueue page", AppendTranscript: "Pi appends page", ReadExactPageAndSyncTranscript: "read exact page and sync", ConfirmPersistedPage: "commit cleanup",
	Unsubscribe: "unsubscribe", CrashAndResume: "crash and resume",
}[action] ?? action);
