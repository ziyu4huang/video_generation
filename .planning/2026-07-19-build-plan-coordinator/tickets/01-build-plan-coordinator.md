---
type: task
status: closed
superseded-by: 2026-07-19-a (decisions 02, 03; build = 2026-07-19-a/09)
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

**Closed — superseded by the unified coordination-layer design.** Every
sub-decision this seed ticket was to grill (where the coordinator lives,
phase-driving, completion detection, command surface, widget section) was
answered under one roof in [`2026-07-19-a`](../../2026-07-19-a/map.md):

- **Where it lives** — inside `pi-agent-ext-goal-todo`, no separate package
  (2026-07-19-a/02).
- **Seam contract** — goal-todo publishes `__piPlanPhases` /
  `__piPlanIncomplete` / `__piPlanSummary` one-way to wayfind; self-consumes
  via internal call (2026-07-19-a/03).
- **Build** — 2026-07-19-a/09.

This effort's "Not yet specified" fog is resolved by those decisions; the
effort itself is retired in favour of `2026-07-19-a`. See
[2026-07-19-a/06](../../2026-07-19-a/tickets/06-close-and-supersede-prior-efforts.md).
ADR-0003 stands as the diagnosis.
