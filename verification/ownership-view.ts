// Statechart view of Ownership.tla; sets arrive as arrays, functions as objects keyed from 1.
export const title = "One live owner per consumer, and lock files only for live owners or crashes";
export const state = (v: any) => ({
	Owners: v.owns.length > 1 ? "Two owners" : v.owns.length ? "One owner" : "No owner",
	"Lock file": v.path === 0 ? "No lock file" : v.holder[v.path] !== "nobody" ? "Lock held" : v.stale ? "Crash leftover" : "Unheld, not a crash",
	State: v.lost ? "Pending pages lost" : { none: "No state", cursor: "Cursor-only state", pending: "Pending pages" }[v.data as string],
});
export const step = (action: string, from: any, to: any) => action === "Sweep" && from.data !== to.data ? "sweep evicts closed state" : ({
	Acquire: "session takes the lock under the quota lock",
	Open: "session opens the lock file",
	Lock: "session locks the opened file",
	Write: "owner saves cursor or pages",
	Close: "session closes",
	Crash: "process dies",
	Sweep: "sweep removes an unheld lock file",
	Idle: null,
}[action] ?? action);
