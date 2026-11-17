---
name: events-delivery-verify
description: Check changes to MCP event acceptance, replay, persistence receipts, session/config identity, stop fences or outbox cleanup. Runs bounded TLA+ safety checks and counterexample replays against actual code.
---

# Delivery verification

## Contract

An accepted event must remain recoverable from its complete local outbox pages or a demonstrably persisted Pi transcript. Removing the outbox at enqueue or `message_end` can lose input after a crash. Never claim exactly-once delivery.

Read `docs/durability.md` and `verification/README.md` first. They define the commit boundary, quota/backpressure policy, counterexamples and model limits.

## Coverage and sync record

Last confirmed source sync commit: `b832ac3832fbbed34c2bedd2b36df84a85bc5b2b`.

- `src/state.ts`: `StateStore.accept/change/flush/acknowledge`, owner/quota locks, committed versus staged cursors, pending retention and bounds.
- `src/receipt.ts`: `persistedReceipts`, exact session/receipt/content match, complete JSONL lines, file and directory sync before cleanup.
- `src/index.ts`: `pump`, `stateKey`, session start/shutdown, runtime intent restore, config retirement/revision fence, unsubscribe.
- `src/subscription.ts`: `Subscription.run/push/poll/handle/stop`, post-await and notification fences; `ServerPool.connectionConfig` identity of resolved settings.
- `src/format.ts`: `formatEvents/formatPages`, complete numbered fragments and untrusted-data boundaries.
- `verification/Delivery.tla`: three session/config identities and one representative page per identity; append and sync are separate actions. `Chart.cfg` is the one-identity visualization bound.
- `test/lifecycle.test.ts` and `test/lifecycle-worker.ts`: real Pi 1.5.2 SDK runtimes, actual loopback MCP and model HTTP, independent HTTP client, owned-PID SIGKILL boundaries, restart, reload, new/resume, concurrent consumers, config changes and shared-connection unsubscribe.
- `test/format-state.test.ts`: full tails, event 11, fragments, disk fault/retry, exact receipts, lock ownership, corruption, quota cleanup and session-slot bounds.

Before changing a covered boundary, compare it with the sync commit. Follow the `maintain-formal-verification-skill` workflow if it changed without a recheck. Move the sync commit forward only after confirming that the model actions and their indivisible boundaries still describe the new code. Tests alone do not establish that correspondence.

## Run from the repo root

1. Run `npm run typecheck`.
2. Run `npm test`. Require all 38 current tests to pass; do not skip the subprocess tests. These must use isolated directories and kill only PIDs they spawned.
3. Install Java 11+ if absent, or point `JAVA` at its binary. Run `npm run verify`. The runner pins TLC 1.7.4 by SHA-256. `TLA2TOOLS` may point to that exact JAR. It downloads the JAR otherwise. The runner writes its evidence under a new temporary directory and prints the path.
4. Read **every TLA+ result with the `statechart` skill**. Use `verification/Delivery.tla` with `Delivery.cfg` for safety results and `Chart.cfg` plus `view.ts` for the pass chart. Run statechart from a scratch directory, not the repo. Read the shortest path for each rejected variant, not just its exit code. The runner's scratch directories contain each variant's config and TLC output.
5. Confirm the four actual-source mutations are rejected: `EarlyAck` by exact receipt checks, `LateStart` by live shared-connection unsubscribe, `SharedKey` by real concurrent consumers, and `ForgetDirty` by disk fault/retry. The runner makes and discards no working-tree edits; its broken copies remain with the temporary evidence. A mutation that no longer matches the source is a failed check, not permission to skip it.
6. After any model or implementation edit, rerun the normal checks. Review `git diff --check` and preserve the real README screenshot. Never tag or publish a durability change without the owner's release approval.

## Interpret the result

The correct three-identity model reaches 6,912 states. Require `AcceptedIsRecoverable`, `ConsumedIsPersisted`, `StopFencesStartup`, `FailedFlushIsRetryable` and deadlock checks to hold. All four deliberately broken variants must produce a counterexample, and the matching implementation mutation must fail its regression test. A changed state count requires explaining the new abstraction or bound, not restoring the old number blindly.

If a model counterexample cannot be replayed against real code, treat it as a modeling error until the real boundary is established. Do not weaken an invariant just to obtain a green check. Keep a failing real regression until the defect is fixed, then recheck the model and mutation sensitivity.

The pass covers only bounded safety. It excludes unbounded liveness, server retention, transport framing, power-loss/hardware guarantees, provider behavior, compaction/branch editing and external effects. Quota arithmetic and payload completeness use actual filesystem/input tests rather than this page-level abstraction. Keep these limits in any report.
