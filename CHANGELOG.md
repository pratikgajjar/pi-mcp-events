# Changelog

## [0.1.0]

- First release. MCP Events (SEP-3415) for the MCP servers in pi's `mcp.json`.
- Push (`events/stream`) and poll (`events/poll`) delivery over stdio and Streamable HTTP.
- Cursors and event-id deduplication persist in `~/.pi/agent/mcp-events-state.json`.
- Tools: `mcp_events_list`, `mcp_events_subscribe`, `mcp_events_unsubscribe`. Command: `/mcp-events`.
