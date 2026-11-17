# Changelog

## [0.1.2]

- Fixed Pi startup failing with `session slots full` after many sessions. State, lock files and slots are now created only on the first subscription or when the session has saved state. Close removes its lock file and empty state.
- State, slot, quota, lock and corrupt-state errors no longer break startup. They show a warning and fail the affected subscriptions.
- Slots count only live owners, pending pages and runtime subscriptions. Stale lock files, including 0.1.1 leftovers, are removed when no owner holds them. When slots fill, the oldest cursor-only state of closed sessions is evicted; pending pages never are.
- Added a TLA+ model of the lock-file lifecycle with code-mutation replays.

## [0.1.1]

- Added per-session durable outboxes. Cleanup requires exact, fsynced Pi transcript receipts; crashes may replay duplicates.
- Delivered every event and complete payload tails in bounded pages. Added disk quotas and visible backpressure without pending eviction.
- Fixed startup unsubscribe races, retry after failed writes, and stale connections after server config changes. Restored runtime subscriptions on reload/resume.
- Added real Pi crash/restart and push/poll tests, plus a bounded TLA+ model with code-mutation replays. Requires Node 22.19+.

## [0.1.0]

- First release. MCP Events (SEP-3415) for the MCP servers in pi's `mcp.json`.
- Push (`events/stream`) and poll (`events/poll`) delivery over stdio and Streamable HTTP.
- Cursors and event-id deduplication persist in `~/.pi/agent/mcp-events-state.json`.
- Tools: `mcp_events_list`, `mcp_events_subscribe`, `mcp_events_unsubscribe`. Command: `/mcp-events`.
