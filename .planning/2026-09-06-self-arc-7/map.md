---
effort: 2026-09-06-self-arc-7
created: 2026-09-06
last: 2026-09-06
status: in-progress
---

# Wayfinder map: 2026-09-06-self-arc-7 — F-invalidate fixed (registry → viewer change channel)

## Destination

Fix the self-arc-6 F-invalidate finding: an open `/subagents` viewer kept
its last painted frame when a background run terminated (stale running row +
frozen elapsed) until a close+reopen forced a fresh render. The registry's
terminal transitions must reach the mounted dialog, and the live receipt
must prove it WITHOUT the reopen kick — the kick was exactly what let this
bug survive four receipts.

## Shipped

- **`SubagentInFlightRegistry.onChange`** (core-runtime
  `subagent-in-flight.ts`): a cross-run DISCRETE-lifecycle channel — fired
  by `start` / `end` / `endBatch` (once per group) / `markCompleted` /
  `markFailed` / `markDetached`. History streaming (`update`) and usage
  accrual deliberately do NOT fire (too hot — live ticking stays the
  renderer's 1s timer's job). `markCompleted`/`markFailed` now also fire the
  per-run bound `invalidate` (parity with `updateModel`/`markDetached`).
- **Viewer-side binding** (`subagents-command.ts` mount): the factory
  subscribes `onChange → viewer.invalidate() + tui.requestRender()` and
  unsubscribes in `onClose`. Root cause documented in place: the 1s timer
  goes silent exactly when the view flips live→not-live, so the transition
  that must repaint was the one the timer skipped.
- **Receipt**: viewer scenario gains `staleRowGoneNoReopen` (required) —
  after the abort notification, the OPEN viewer must drop the stale row with
  no keypress and no reopen; the close+reopen kick is demoted to the phase-2
  diagnostic fallback for `staleRowGone`.
- **Tests**: registry-level describe (fires on the six transitions;
  endBatch fires once per group; update/updateModel/accrueUsage don't fire
  the change channel; unsubscribe safe twice) + command-level wiring test
  (timer stubbed out, so any re-render can only come from the channel;
  closed viewer receives nothing) + a hardening source pin (phase 1 must not
  contain the reopen write).

## Tickets

- [x] t01 — registry change channel + terminal invalidate (core-runtime) + unit tests
- [x] t02 — viewer-side subscription in the /subagents mount + command wiring test
- [x] t03 — receipt `staleRowGoneNoReopen` + hardening pin + live proof on the deployed tree

## Execution order

t01 → t02 → t03 (single PR; live receipt only meaningful on a redeployed tree).

## Findings

- (recorded live, to fill at close-out)

## Receipts

- source: `output/self-arc7-receipt-2026-09-07/` (pending)
- deployed: same run, post-merge redeploy `0.10.0+g<merge sha>` (pending)
