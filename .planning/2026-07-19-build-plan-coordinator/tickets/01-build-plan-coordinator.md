---
type: task
status: open
---

# 01 — Build the plan coordinator (the missing middle phase layer)

## Question

Build the plan coordinator — the phase layer of the `goal ↔ plan ↔ todo` model — so the cross-layer coordination that is today graceful no-ops (designed-but-not-built, ADR-0003) becomes real: publish `__piPlanPhases` / `__piPlanIncomplete` / `__piPlanSummary`, drive `task_plan.md` phases, register composite-widget slot order=3, and make `goal_complete`'s gate + `/wayfind sync` actually fire?

## What to build

A component that, at runtime: (a) parses the `task_plan.md` phase spine (contract tokens pinned by `plan-seed-contract.test.ts`: `### Phase`, `**Status:** pending`, `# Task Plan` / `## Goal` / `## Phases`); (b) drives/tracks phase status; (c) publishes the three `__piPlan*` seam keys on `globalThis` (process-singleton, graceful when absent — mirroring `__piGoalActive` / `__piWayfindActive`); (d) registers a phase-progress section in the composite status widget (slot order=3, via `status-widget.ts` `addSection`); (e) yields its injection/auto-continue when `__piGoalActive` or `__piWayfindGrill` is active. The three already-coded consumers (`goal.ts` `planningGateBlocking` / `planProgressLineFromPeer`; `chain.ts` `syncChainState`; `coordination.ts` readers) then light up without further changes.

## Acceptance

- [ ] The three `__piPlan*` seams are published by exactly one package; grep finds the publishers (today: zero).
- [ ] `goal_complete`'s `planningGateBlocking()` returns a blocking reason when phases are incomplete — end-to-end: a `/goal` with an open `task_plan.md` blocks `goal_complete` until phases close.
- [ ] `/wayfind sync` closes a wayfind ticket whose phase reports `complete` (the loop's feedback half — currently a no-op).
- [ ] Composite widget renders a phase-progress section at slot order=3.
- [ ] The manual skill-layer stopgap (ADR-0003 / PR #678) is preserved as the graceful fallback when the coordinator is absent.
- [ ] wayfind + goal-todo + the new package `bun test` green; `plan-seed-contract.test.ts` still passes.

## Resolution

(open — deferred. When worked: grill the "Not yet specified" sub-decisions on the map into sub-tickets, then build. See ADR-0003 for the full diagnosis + grep evidence.)
