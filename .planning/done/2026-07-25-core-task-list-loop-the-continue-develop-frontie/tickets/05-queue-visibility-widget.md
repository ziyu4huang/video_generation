## Question

How does the queue show in core-task's status widget — a compact, scannable representation that doesn't bloat the lightweight cockpit?

## type: prototype

## blocked by: 03  ✅ (03 closed)

## claimed: agent (2026-07-25)
## status: closed (2026-07-25)

## Context

- core-task has a status-widget (`src/shared/status-widget.ts`) showing the active goal. A queue adds a second dimension (position + count + upcoming).
- Reference renders via `goal-loop-display.ts` (status line + `/goal status`).
- Constraint: the widget must stay compact (lightweight cockpit); don't duplicate the whole queue in the chrome.

## To prototype

1. **One-line summary:** e.g. `▣ goal 2/5: <active text>` (+ `… 3 queued`) — position + total + elided upcoming count.
2. **Detail view:** `/list` (the command itself, ticket 03) shows the full queue with indices; the widget only teases it.
3. **State cues:** how to show a paused/failed item in the queue (red marker? `⚠`?) vs a clean-queued one.
4. **Widget interaction:** does selecting a queued item promote it (UX), or is promotion command-only (`/list next`)? Keep widget read-only for v1.

## Deliverable

A rough mock of the widget line (ASCII / current-widget diff) for the user to react to — raises fidelity before any spec.

## Resolution

**Option A — dim suffix `· ☰ position/total` (+ `· ⚠N parked`); shown only when `total ≥ 2`.** Confirmed via the mock review.

### Current line (unchanged — the baseline)
```
🎯 goal active · 1m23s · iter 3  refactoring the parser
```
(`formatGoalOverlayLine(goal, theme, width)` in `src/goal/format.ts:115`; icon + colored status word, dim metric + iter, dim objective.)

### With a queue
```
🎯 goal active · 1m23s · iter 3  refactoring the parser  · ☰ 2/5
🎯 goal active · 1m23s · iter 3  refactoring the parser  · ☰ 2/5 · ⚠1 parked
✓ goal complete  refactoring the parser        (flash line unchanged; head advances → ☰ 3/5)
```

### Rules
- **`total < 2` → no queue segment at all.** A bare `/goal` or a 1-item list renders byte-identical to today (zero regression — the lightweight-cockpit promise).
- **Narrow terminal:** drop the `☰ N/M` segment *before* truncating the status head (the head is the signal; the queue is secondary).
- **Glyphs** (`☰` for queue, `⚠` for parked) are cosmetic — finalize during implementation.
- **Detail lives in `/list`** (ticket 03): the full indexed list with state markers; the widget only teases `☰ N/M`.

### Signature
```ts
formatGoalOverlayLine(
  goal: ActiveGoal, theme: Theme, width: number,
  queue?: { position: number; total: number; parked?: number },
): string
```
Optional 4th param; absent or `total < 2` → today's exact output. `GoalOverlay.render` (`src/goal/overlay.ts:75`) passes the queue slice from `GoalRuntimeState.list` when rendering.

**Closed:** 2026-07-25.
