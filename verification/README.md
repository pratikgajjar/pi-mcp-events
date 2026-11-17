# Delivery model

Run `npm run verify` with Java 11+ installed (`JAVA` can name its binary). It checks two models: `Delivery.tla` for accepted pages and `Ownership.tla` for the lock-file lifecycle. The script downloads TLC 1.7.4 and checks its SHA-256. `TLA2TOOLS` can select a local copy of that exact JAR. All TLC state files and source mutations stay in isolated temporary directories. The command prints their path.

## Safety rules

| Rule | Promise | Code boundary |
| --- | --- | --- |
| `AcceptedIsRecoverable` | Accepted input has a pending page or a synced transcript receipt. | `StateStore.accept/flush`, `pump`, `persistedReceipts` |
| `ConsumedIsPersisted` | Cleanup cannot acknowledge a merely queued page. | `persistedReceipts` then `StateStore.acknowledge` |
| `StopFencesStartup` | A stopped subscription cannot create a stream. | `Subscription.run/push/stop` and post-await fences |
| `FailedFlushIsRetryable` | A failed write leaves a staged transaction to retry. | `StateStore.change/flush` |

`AcceptAndSaveOutbox` models the successful atomic rename after file sync; the code does not expose its cursor or enqueue until directory sync returns. `QueuePage` is `pi.sendMessage`, not consumption. `AppendTranscript` is Pi's append after its extension event dispatch. `ReadExactPageAndSyncTranscript` is the disk evidence check, file sync and directory sync; interruption before completion cannot authorize cleanup. `ConfirmPersistedPage` is a separate outbox commit. Crash clears volatile queues and unaccepted staged writes, retains committed outboxes and synced history, and may choose another session/config identity. Locks exclude a second simultaneous owner of one consumer; `Ownership.tla` models that lifecycle, and tests exercise actual SQLite locking.

The full model reaches **6,912 states** at three consumer identities: two sessions on one config and one session on another config, one representative page each. All four invariants and deadlock checks pass. `Chart.cfg` uses one identity and reaches 144 states. Read every TLA+ result with the `statechart` skill; use `view.ts` for its plain-language chart. It hides 489 steps whose labels do not change, chiefly flush staging/failure/retry and resets that remain in the same visible state.

## Counterexamples and real replays

The checker must reject each broken variant. `check.mjs` then makes the related source change in a scratch copy and requires a real regression test to fail. These mutations never touch the working source.

| Broken variant | Shortest model path | Actual-code replay |
| --- | --- | --- |
| `EarlyAck` | Connect, choose delivery, save, queue, acknowledge before append. Both recoverability and persistence fail. | Skip the disk check in `receipt.ts`; the exact-receipt test rejects it. The real Pi subprocess test also proves `message_end` occurs before append and kills there. |
| `LateStart` | Connection returns, unsubscribe, mode returns and starts a stream. | Remove post-await/push fences; real HTTP tests retain a sibling connection and observe forbidden stream creation. |
| `SharedKey` | Save for consumer A, crash/resume as B, reuse A's replay key. | Give all sessions one state filename; real concurrent Pi consumers fail the isolation test. Endpoint replacement is also tested against real requests. |
| `ForgetDirty` | Stage a write, fail flush, forget the staged transaction. | Clear `staged` on write failure; the filesystem fault/retry test rejects it. |

Initial independent source probes reproduced the old implementation's queue loss, shared-key suppression, event 11/tail omission, startup race and failed-flush retry loss. The shipped tests exercise the repaired boundaries with real Pi, actual files, process death and an independent HTTP client.

## Pass chart (one consumer)

```mermaid
stateDiagram-v2
  s0: Connecting
  s1: Stopped, no input
  s2: Choosing delivery
  s3: Listening
  s4: Saved in outbox
  s5: Queued, not persisted
  s6: Stopped, pending retained
  s7: Appended, not synced
  s8: Synced, pending cleanup
  s9: Persisted, cleaned
  [*] --> s0
  s0 --> s1: unsubscribe
  s0 --> s2: connection returns
  s1 --> s0: crash and resume
  s2 --> s0: crash and resume
  s2 --> s1: unsubscribe
  s2 --> s3: delivery chosen
  s3 --> s0: crash and resume
  s3 --> s4: save complete page and cursor
  s3 --> s1: unsubscribe
  s4 --> s5: enqueue page
  s4 --> s6: unsubscribe
  s5 --> s4: crash and resume
  s5 --> s7: Pi appends page
  s5 --> s6: unsubscribe
  s6 --> s4: crash and resume
  s7 --> s4: crash and resume
  s7 --> s8: read exact page and sync
  s7 --> s6: unsubscribe
  s8 --> s9: commit cleanup
  s8 --> s6: unsubscribe
  s6 --> s8: crash and resume
  s6 --> s9: commit cleanup
```

This is a finite safety model, not an exactly-once or liveness proof. It abstracts event bytes, quota arithmetic, transport framing, disk hardware, server retention, compaction, branch editing and external actions. Real tests cover multiple events, fragmentation, disk failure, quota backpressure, live config changes, reload/resume and concurrent clients. See [delivery bounds](../docs/durability.md).

## Lock-file ownership model

`Ownership.tla` models one consumer path, three processes and up to four distinct lock files (inodes). One step that runs under the global quota lock is one atomic action.

| Rule | Promise | Code boundary |
| --- | --- | --- |
| `OneOwner` | At most one process owns a consumer. | `StateStore` constructor (`tryLock` under `quota`), `close` |
| `PendingKept` | No sweep or close removes pending pages. | `classify`, `admit`, `close` |
| `LockFileMeansOwnerOrCrash` | An unheld lock file is only a crash or 0.1.1 leftover. | `close` unlinks under the quota lock; `cleanStaleLocks` |

`Acquire` is the first subscribe, or a start with saved state: open plus a non-waiting lock under the quota lock. A busy lock fails closed. `Write` is any owner save. `Close` unlinks the lock file by name, then unlocks. `Crash` releases the OS lock and leaves the file. `Sweep` is `cleanStaleLocks` or the full-slot sweep in `admit`: only a lock it can take proves no live owner; it may then evict cursor-only state. Slot arithmetic is not modeled; real tests cover it.

The correct model reaches **60 states**. All three rules and deadlock checks pass.

| Broken variant | Shortest model path | Actual-code replay |
| --- | --- | --- |
| `UnlinkUnheld` | A takes the lock; a sweep unlinks the held file; B creates a new file and also owns. | Unlink without `tryLock` in `cleanStaleLocks`; the live-owner cleanup test rejects it. |
| `OpenOutsideQuota` | B opens the file; a sweep unlinks it; B locks the unlinked file; C creates and locks a new one. | Model only. The race needs two processes between open and lock in a synchronous constructor, which a test cannot interleave deterministically. |
| `KeepLockOnClose` | A session takes the lock and closes; the file stays without an owner (the 0.1.1 slot leak). | Close keeps the lock file; the real Pi empty-session test rejects it. |
| `EvictPending` | Save pending pages, close, sweep evicts them. | `classify` ignores pending pages; the slot-sweep test rejects it. |

Read the result with the `statechart` skill and `ownership-view.ts`. The chart hides 93 steps that stay in one chart state, chiefly repeated saves and sweeps with nothing to remove.

```mermaid
stateDiagram-v2
  direction LR
  state "At the same time" as all {
    state "Owners" as r0 {
      s0: No owner
      s1: One owner
      [*] --> s0
      s0 --> s1: session takes the lock under the quota lock
      s1 --> s0: session closes or process dies
    }
    --
    state "Lock file" as r1 {
      s2: No lock file
      s3: Crash leftover
      s4: Lock held
      [*] --> s2
      [*] --> s3
      s2 --> s4: session takes the lock under the quota lock
      s3 --> s2: sweep removes an unheld lock file
      s3 --> s4: session takes the lock under the quota lock
      s4 --> s2: session closes
      s4 --> s3: process dies
    }
    --
    state "State" as r2 {
      s5: No state
      s6: Cursor-only state
      s7: Pending pages
      [*] --> s5
      s5 --> s6: owner saves cursor or pages
      s5 --> s7: owner saves cursor or pages
      s6 --> s7: owner saves cursor or pages
      s7 --> s6: owner saves cursor or pages
      s6 --> s5: sweep evicts closed state [no owner, lock not held]
    }
  }
```

The model abstracts SQLite internals, journal files, multiple consumers and slot counts. It assumes OS locks release on process death and that every acquirer uses the quota lock; 0.1.1 also acquires under it. A close that cannot get the quota lock within its wait keeps the lock file; the model treats that like `Crash`.
