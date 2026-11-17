# Changelog

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
