---
type: task
blocking: []
status: closed
---

## Question
The agent re-applies a patch without investigating **why** a prior patch was unapplied — failure memories #276/#279. No structural instruction enforces root-cause-first before re-patching.

## What to build
- Add an explicit step to `bun-apps/pi-agent-ext-wayfind/procedures/wayfinder.md` (the work-the-map discipline): **before re-applying a fix, investigate why the prior one didn't stick** (was it reverted? test gap? wrong layer? applied to a stale worktree?). Cite the memory/commit/diff as evidence.
- Keep it concise and actionable; place it where re-patching / fix-iteration arises in the procedure.

## Acceptance
- The "investigate-WHY-before-repatch" step is present in `procedures/wayfinder.md`.
- The procedure file renders/parses cleanly and the procedure-path resolver still points to it (no broken reference).

## Resolution
Fixed in `658f64e7`: added an explicit "investigate-WHY-before-repatch" step to `procedures/wayfinder.md` (root-cause-first: reverted? test gap? wrong layer? stale worktree? cite memory/commit/diff), placed where fix-iteration arises.
