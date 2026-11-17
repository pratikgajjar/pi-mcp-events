# Delivery and recovery

## Commit boundary

```text
server event
   |
   v
atomic local save: cursor + accepted IDs + complete pending pages
   |
   v
Pi follow-up queue (volatile, one page in flight)
   |
   v
message_end -> Pi transcript append -> exact disk read + fsync
                                         |
                                         v
                                remove pending page
```

`message_end` is not a receipt. Pi can emit it before appending the custom message. Pi can also hold setup/custom entries in memory until a user or assistant message creates the session file. The extension checks the actual JSONL file, session ID, receipt ID and exact model-visible content. It syncs the file and its directory before committing cleanup. An in-memory session cannot produce this evidence, so its pages remain pending.

Acceptance means the local outbox commit completed. Recent IDs dedupe **accepted**, not necessarily consumed, events. A cursor can advance at acceptance because the same commit contains the complete pending pages. Failed writes keep a retryable staged snapshot; replay requests use only the committed cursor. A stop or cleanup may replace an unaccepted failed transaction. A crash before acceptance still needs the server's replay retention.

A crash after transcript persistence but before cleanup normally recovers by checking disk. Duplicate replay remains possible, including during reload, uncertain sends, interrupted cleanup and the 200-ID recent dedupe window. There is no exactly-once claim. Persistence proves the input reached history, not that the model acted on it or completed an external effect.

## Identity and lifecycle

State lives in `~/.pi/agent/mcp-events/<session-hash>.json`, mode `0600`, under a private directory. The session ID and transcript path identify the consumer. Reload and resume of the same session reuse it. New and forked sessions use separate state. A subscription key also hashes the workspace, server alias, explicit effective connection config and arguments. Resolved headers and environment overrides affect the hash; credentials are not stored in that hash's input text on disk.

SQLite supplies OS locks for session ownership and quota checks. It stores no payloads. Locks release on process death. Concurrent opens of the same consumer fail closed. Independent sessions do not merge cursors or share dedupe. Use local storage with working SQLite locks and atomic rename; network filesystem behavior is not covered.

Runtime subscription intent survives reload and resume. Server config changes stop existing subscriptions and close old connections before reconnecting. Endpoint/auth changes use another replay key. Pending pages for old keys remain stored and paused. Restoring that exact config and subscribing again makes them eligible for replay. Unsubscribe stops new stream creation and page enqueue, including during connection and descriptor awaits. It cannot retract a page already queued in Pi. Pending pages stay on disk until resubscription or confirmed persistence.

Version 0.1.1 does not import the old shared `mcp-events-state.json`: it cannot tell which session consumed those IDs. Retained source events may therefore replay on upgrade. Keep the old file as a backup; it cannot recover events the old version already skipped.

## Complete input, bounded storage

Each small event gets its own message. Large events use numbered JSON-string fragments of at most 8,000 source characters. Concatenating the decoded strings recovers the complete event JSON. No eleventh event or payload tail is silently omitted. Only the TUI preview is shortened. A reported replay gap has its own durable page, even when the batch contains no new events.

Default bounds:

| Resource | Limit |
| --- | --- |
| Session snapshot | 16 MiB |
| Pending pages per session | 4,096 |
| Subscription/config keys per session | 128 |
| Recent accepted IDs per key | 200, plus all still-pending IDs |
| Session slots | 1,024 |
| Aggregate snapshots, including abandoned temp writes | 128 MiB admission budget |
| Extra atomic-write headroom | 16 MiB; 144 MiB hard payload-file ceiling |
| Extension log | About 2 MB plus one rotated file |
| Queued pages | One per loaded extension instance |

Filesystem metadata, SQLite lock files and Pi-owned transcripts are outside the payload-file byte count. Slot count bounds lock-file count. Limits assume only the extension writes this directory. Oversized batches/metadata and quota failures do not advance the committed cursor. Poll retries with backoff. Push cancels and reconnects from the saved cursor. Pending events are never evicted to make space. Server retention can expire during backpressure; a server's `truncated` notice is persisted, but a server that hides gaps cannot be repaired locally.

## Recovery and cleanup

- Inspect `/mcp-events`, `mcp_events_list` and `~/.pi/agent/mcp-events.log` for retry/quota errors. `pendingPages` includes paused pages; `accepted` is not a consumption count.
- Allow the owning session to consume pending pages. Cleanup removes complete payload pages after the persistence check. Recent IDs and cursor metadata remain bounded.
- Fix disk/permission errors, then reload or resume. A failed/unknown `pi.sendMessage` is not acknowledged. One in-flight page may wait until reload; the void API gives no safe queue cancellation/completion handle.
- To reclaim inactive session slots, first stop all Pi processes that use this agent directory. Back up the relevant `.json` and matching `.json.lock` files outside it. Remove only state you explicitly abandon. Check `pending` first; deleting a nonempty outbox abandons accepted input. Removing cursor state may permit source duplicates. Never remove a live lock file.
- A leftover `.json.tmp` is an uncommitted write. Resume of its owner removes it while holding the session lock. To remove another owner's orphan, stop its process first and preserve its `.json`. A corrupt state file fails closed; keep it for repair instead of resetting it to empty.

Receipt scans stream JSONL with bounded line memory, but scan cost grows with transcript size. A modified or missing transcript, altered custom message, failed sync, or unavailable session file keeps pages pending. Model context limits, compaction and intentional branch changes remain Pi's responsibility.

## Verification

Run `npm run typecheck`, `npm test`, and `npm run verify` (Java 11+). The latter pins TLC 1.7.4, checks 6,912 model states, rejects four broken variants, and replays those variants against mutated copies of the actual code in temporary directories. The repository's delivery verification skill maps each model action to source.

Real Pi 1.5.2 SDK subprocess tests use local HTTP MCP push/poll servers and a local model endpoint. An independent HTTP client checks the fixture without extension client code. Tests kill only their own worker PIDs, once while a page is queued and once inside the real `message_end` hook before transcript append. Restart persists all 11 events and the full 21,000-character payload in 13 pages. Tests also exercise reload, new/resume, concurrent sessions, live config disable/endpoint change, and unsubscribe during both startup awaits while another subscription retains the connection.

The model covers three consumer/config identities, one representative page per identity, queue loss, append, sync, cleanup, stop and failed flush. It proves only these bounded safety rules. It does not prove transport correctness, disk hardware behavior, power-loss recovery, unbounded fairness, provider behavior, server retention or external effects. Fault tests and model checks complement each other; neither is a whole-system proof.
