---
type: task
status: closed
blocked by:
findings: M1
resolved: 2026-08-12 — shipped in #1059 — `reviewerEnqueued` hoisted pre-try; catch preserves the queue (`preserveList`), no data loss on confirm-throw
---

# 04 — Reviewer data-loss: `ui.confirm` throwing after enqueue drops enqueued `/list` items

## Problem

If `runReviewer` enqueues N bug/refactor items to `/list` (persisted) and the subsequent `ctx.ui.confirm` loop then throws (UI race / IPC error), the catch calls `clearActiveGoal(ctx)` with default `preserveList: false` — erasing the just-enqueued items. The happy path proves the intent (`preserveList: reviewerEnqueued > 0`); the catch diverges. The spec §10.1 flagged this **high** and prescribed the fix; never applied.

## Evidence

- `core-task/src/goal/goal.ts:367` `try {`; `:369` `let reviewerEnqueued = 0` declared **inside** the try (out of scope in catch).
- `:392-396` enqueue mutates `goalState.list` + persists, incrementing the counter.
- `:455-457` `catch (reviewerError) { … clearActiveGoal(ctx); }` — no `preserveList`.
- Happy path: `:461` `clearActiveGoal(ctx, { preserveList: reviewerEnqueued > 0 })`.
- Spec: `docs/2026-07-31-reviewer-spec.md:280-283`.

## Approach

1. Hoist `let reviewerEnqueued = 0;` to **before** the `try` (primitive counter — safe to leak to the catch).
2. Change the catch to `clearActiveGoal(ctx, { preserveList: reviewerEnqueued > 0 })`.
3. Add the `confirmThrows-after-enqueue` test the spec named: enqueue N items, make `ui.confirm` throw, assert the items survive in `goalState.list`.

## Acceptance

- [ ] Hoist + `preserveList` applied; the new test passes (items survive a confirm-throw).
- [ ] No regression in the normal-completion path.
