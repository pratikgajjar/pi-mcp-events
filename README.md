# pi-mcp-events

A [pi](https://pi.dev) extension for MCP Events. An MCP server sends an event,
and the event wakes your pi session. The agent then acts on it without a prompt
from you.

It works with the MCP servers that you already configured in pi's built-in
`mcp.json`. It needs no adapter, no fork and no build step.

![A pi session wakes when a letagents message arrives as an MCP event](./assets/demo.png)

_A real pi session. A letagents message arrived. The letagents MCP server
pushed a `message.received` event, and pi started a turn without a prompt._

## Install

```bash
pi install npm:@pratikgajjar/pi-mcp-events
```

To try it for one run only:

```bash
pi -e npm:@pratikgajjar/pi-mcp-events
```

## How it works

```text
 mcp.json ──► server config        mcp-events.json ──► subscriptions
                   │                        │
                   ▼                        ▼
            ┌─────────────────────────────────────┐
            │ pi-mcp-events: its own connection   │
            │ to each server with a subscription  │
            └──────────────┬──────────────────────┘
       push: events/stream │ poll: events/poll
                           ▼
                    MCP server (stdio or HTTP)
                           │ event
                           ▼
       dedupe by eventId, save cursor ──► mcp-events-state.json
                           │
                           ▼
       pi.sendMessage(triggerTurn) ──► idle: a turn starts
                                       busy: queued as a follow-up
```

pi does not share its MCP connections with extensions. So the extension opens
its own connection to each server that has a subscription. Servers without a
subscription get no extra connection.

## Subscribe

You can subscribe in two ways.

**1. Ask the agent.** The extension gives the model three tools:

- `mcp_events_list(server?)` shows the events that servers offer, and the
  active subscriptions.
- `mcp_events_subscribe(server, event, arguments?, delivery?)` starts a
  subscription for this session. `server` is the name in `mcp.json`. The
  form `mcp__<server>` also works.
- `mcp_events_unsubscribe(server, event, arguments?)` stops it.

For example: "Subscribe to message.received on letagents and tell me who writes."

**2. Write a file.** Subscriptions in `~/.pi/agent/mcp-events.json` start in
every session:

```json
{
  "subscriptions": [
    { "server": "letagents", "event": "message.received", "arguments": { "include_text": true } }
  ]
}
```

Optional fields for each subscription:

- `delivery`: `"push"` or `"poll"`. The default is push when the event offers
  push, else poll.
- `maxAgeMs`: do not replay events older than this after a restart.

`/mcp-events` shows each subscription with its mode, its state and its event
count. The footer shows `events <active>/<total>`.

## Server configuration

The extension reads servers in the same order as pi:

1. Servers that other extensions register (`pi.getMcpServers()`).
2. `~/.pi/agent/mcp.json`.
3. The project `.pi/mcp.json`, only when pi trusts the project.

It uses the same fields as pi: `command`, `args`, `env` and `cwd` for stdio,
and `url` and `headers` for Streamable HTTP. `${VAR}` and `!command` values
resolve as in pi. Servers with `enabled: false` are skipped.

## Delivery rules

The extension follows SEP-3415 for push and poll:

- **Push.** One `events/stream` request for each subscription. Notifications
  are routed by `_meta["io.modelcontextprotocol/subscriptionId"]`. With no
  event or heartbeat for 60 s (or 3 times a granted `heartbeatMs`), the client
  cancels the stream and opens it again from the last cursor. On stdio, cancel
  is `notifications/cancelled`. On HTTP, cancel aborts the request.
- **Poll.** One `events/poll` loop for each subscription. It honours `cursor`,
  `hasMore` and `nextPollMs`, with a floor of 1000 ms.
- **Cursors.** The extension saves the cursor of each `(server, event,
  arguments)` in `~/.pi/agent/mcp-events-state.json`. A `null` cursor is never
  replayed.
- **Duplicates.** The extension drops an `eventId` that it already delivered
  for the same subscription.
- **Gaps.** When the server sends `truncated: true`, the message tells the
  model that earlier events can be missing.
- **Errors.** A transient error retries with backoff and jitter. `NotFound`,
  `Forbidden`, `InvalidParams`, `Unsupported` and
  `notifications/events/terminated` end the subscription, and pi shows a
  warning. A `schema_changed` termination lists the events again and
  resubscribes.

## Safety

Event data comes from outside. The message to the model names the server and
the event. It says that the data is untrusted input from that server and not
an instruction from the user. The data is JSON inside an `<mcp-event>` tag,
and `<` is escaped, so a payload cannot close the tag. Each message shows at
most 10 events and 2,000 characters for each event.

## What this extension does differently

Other pi packages for MCP Events exist (see [Related projects](#related-projects)).
This one has these properties:

- **It uses pi's built-in MCP.** It reads pi's own `mcp.json`, honours project
  trust, and follows pi's override rules. You do not replace pi's MCP support
  and you do not install an adapter fork.
- **It runs from source.** pi loads the TypeScript directly. There is no build
  step and no runtime dependency.
- **It follows the current spec.** It implements SEP-3415 at the accepted
  commit (below). It reads the capability only from
  `capabilities.extensions["io.modelcontextprotocol/events"]`, sends
  `heartbeatMs`, sends per-request client capabilities in `_meta`, and sets
  the `Mcp-Name` header on HTTP.
- **It is user-level.** Subscriptions live in `~/.pi/agent/mcp-events.json`
  and in the session. They follow you to every project.
- **It is small.** About 1,400 lines, with a small JSON-RPC client. The tests
  cover the poll and push loops, reconnect, termination, HTTP, config and
  state.
- **It was tested on a real network.** Push and poll were checked with the
  letagents MCP server and messages from another machine.

## Specification

This extension implements
[SEP-3415: Events Extension](https://github.com/pja-ant/modelcontextprotocol/blob/4165cc2e580afa795842002f631edbbe17c63757/seps/3415-events-extension.md),
pinned at commit `4165cc2` (the accepted proposal,
[PR #3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415)).
The proposal can change before it is final.

## Not supported

- **Webhook delivery.** A laptop has no public URL. Events that offer only
  webhook delivery fail with a clear error.
- **OAuth servers.** HTTP servers with `oauth` or provider `auth` are skipped.
  A static `Authorization` header works.
- **The `2026-07-28` handshake.** The extension uses `initialize`, not
  `server/discover`, and does not open `subscriptions/listen`. A
  `notifications/events/list_changed` that arrives on the connection clears
  the cached event list.
- **The legacy top-level `events` capability** of early prototypes. A server
  must use the `extensions` entry.
- **SSE transport** (as in pi).

## Files

| File | Purpose |
|---|---|
| `~/.pi/agent/mcp-events.json` | Subscriptions that start in every session |
| `~/.pi/agent/mcp-events-state.json` | Cursors and recent event ids (mode 0600) |
| `~/.pi/agent/mcp-events.log` | Connections, subscriptions and event ids |

## Develop

```bash
npm ci
npm run typecheck
npm test
pi -e ./src/index.ts
```

`scripts/capture.sh` records the README screenshot from a real pi session, and
`scripts/render.py` turns it into `assets/demo.png`.

## Related projects

- [@sanity-labs/pi-mcp-events](https://github.com/sanity-labs/pi-mcp-events):
  SEP-3415 with poll, stream and signed webhooks, and a demo weather server.
  Subscriptions are per project.
- [@realmikekelly/pi-mcp-events](https://github.com/mikekelly/pi-mcp-events):
  events streams with idle wake-ups, a companion to a forked `pi-mcp-adapter`.
- [richardanaya/pi-mcp-extensions](https://github.com/richardanaya/pi-mcp-extensions):
  pi packages for MCP skills, tasks, apps and events.
- [MCP Triggers & Events Working Group](https://github.com/modelcontextprotocol/experimental-ext-triggers-events):
  the design sketch and the reference work.

## License

MIT
