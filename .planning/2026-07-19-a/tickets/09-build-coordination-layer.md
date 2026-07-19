---
type: task
status: open
---

# 09 — Build the goal-todo coordination layer (the destination)

## Question

Build the coordination layer **inside `pi-agent-ext-goal-todo`** per the settled design ([01](01-revert-skill-edits-restore-fidelity.md) fidelity, [02](02-unified-coordination-layer.md) home+format, [03](03-seam-name-unification.md) seam contract): parse the canonical **writing-plans format** (Task ≡ phase), drive the `/goal`+`todo` singletons from it, gate `goal_complete` on plan-completion, and publish `__piPlanPhases`/`__piPlanIncomplete`/`__piPlanSummary` (internal-call for goal-todo's own consumption; globalThis for wayfind) — so wayfind's existing readers light up.

This is the **doing** (the destination), handed to superpowers `writing-plans` → execution. Working this ticket = invoke writing-plans to decompose into tasks, then execute.

## What to build

- **Parser**: read writing-plans-format plans (`# [Feature] Implementation Plan`, `### Task N — [NN-slug]`, `- [ ] Step`); map Task → `PlanPhaseInfo {id, status, ticketIds?}` (Task≡phase from [02](02-unified-coordination-layer.md)).
- **Publish + consume**: publish `__piPlanPhases`/`__piPlanIncomplete`/`__piPlanSummary` on `globalThis` for **wayfind**; goal-todo consumes via **internal-call** ([03](03-seam-name-unification.md)) — refactor `goal.ts` `planningGateBlocking`/`planProgressLineFromPeer` to call the layer directly (drop the globalThis self-read).
- **Drive goal/todo**: seed the `todo` list from the plan's Tasks/Steps (structure = plan-master); gate `goal_complete` on all-phases-complete.
- **Yield**: respect `__piGoalActive`/`__piWayfindGrill` (don't double-drive during a grill).
- **Graceful**: no-op cleanly when no plan / peer absent.

## Acceptance

- [ ] goal-todo parses a writing-plans-format plan into `PlanPhaseInfo[]`.
- [ ] `todo` list mirrors the plan's Tasks/Steps; `goal_complete` is gated on plan-completion (internal-call, no globalThis self-read).
- [ ] `globalThis.__piPlanPhases`/`__piPlanIncomplete`/`__piPlanSummary` published by goal-todo; wayfind `chain.ts` `syncChainState` + `coordination.ts` readers light up (end-to-end: a completed Task → `/wayfind sync` closes its `[NN-slug]` ticket).
- [ ] goal-todo + wayfind `bun test` green.
- [ ] Superpowers skills stay byte-identical (no skill edits — [01](01-revert-skill-edits-restore-fidelity.md) invariant holds).

## Inputs (the spec = settled design)

- [01](01-revert-skill-edits-restore-fidelity.md) — invariant: skills untouched.
- [02](02-unified-coordination-layer.md) — home: inside goal-todo; format: writing-plans; Task≡phase.
- [03](03-seam-name-unification.md) — seam contract: 3 `__piPlan*`; internal-call self-consume.
- ADR-0003 — the manual stopgap this automates.
- Companions: [04](04-sync-timing-and-lifecycle.md) (timing — decide within the build), [08](08-wayfind-migrates-to-writing-plans-format.md) (wayfind emits writing-plans format — for wayfind-driven flows).
