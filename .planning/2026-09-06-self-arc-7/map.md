---
effort: 2026-09-06-self-arc-7
created: 2026-09-06
last: 2026-09-06
status: done
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

- The fix is INVISIBLE at the data layer — `views()`/`entries()` had been
  correct since self-arc-6; only the render trigger was missing. Lesson:
  when a UI "stale frame" bug survives a data-layer fix, the next suspect
  is the render-scheduler gap (timer guards), not the projection.
- The 1s live timer's `hasLiveContent()` guard creates a systematic blind
  spot: it stops rendering EXACTLY at the live→terminal flip, the one
  transition a lifecycle viewer must paint. Any future live viewer in the
  repo should pair its ticking timer with a discrete-change subscription.
- Receipt-design lesson (why this survived four receipts): judging a frame
  only AFTER forcing a re-render (the reopen kick) tests the data layer
  twice and the render trigger zero times. A receipt must observe the
  default render path before any reset gesture.

## Receipts

- deployed `0.10.0+g609562a`: `output/self-arc7-receipt-2026-09-07/` —
  10/10 PASS incl. `staleRowGoneNoReopen: true`; snap-09 (first poll, ~2.5s
  after the abort notification) already shows the stale `bg      ●` row
  gone with NO reopen (no `stale-row-after-reopen` snap exists — phase 2
  never ran; 10 snaps vs 12 pre-fix). PR #2198, squash `609562a2`.
