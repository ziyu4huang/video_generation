---
type: task
status: open
concrete-build: complete 2026-07-20 (#715–#719)
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

- [x] goal-todo parses a writing-plans-format plan into `PlanPhaseInfo[]`. _(TB1, #715)_
- [x] `todo` list mirrors the plan's Tasks/Steps; `goal_complete` is gated on plan-completion (internal-call, no globalThis self-read). _(TB3 #716 + TB4 #717)_
- [x] `globalThis.__piPlanPhases`/`__piPlanIncomplete`/`__piPlanSummary` published by goal-todo; wayfind `chain.ts` `syncChainState` + `coordination.ts` readers light up (end-to-end: a completed Task → `/wayfind sync` closes its `[NN-slug]` ticket). _(TB2 #715 + TB6 #718 — TB6 found+fixed a status-token contract bug `complete`→`completed`)_
- [x] goal-todo + wayfind `bun test` green. _(304 + 144)_
- [x] Superpowers skills stay byte-identical (no skill edits — [01](01-revert-skill-edits-restore-fidelity.md) invariant holds). _(ADR-0004 guard)_

## Status — concrete build complete (2026-07-20)

All 6 concrete tracer-bullets merged: **1** parser, **2** publish-seams, **3** goal.ts internal-call, **4** drive-todo (plan-master seed), **5a** refresh-gating (mutating tools), **6** e2e verify (found+fixed a cross-package `complete`→`completed` status-token bug). Plan docs: `.planning/2026-07-19-a/plans/01–06`.

**Remaining — design/migration, NOT concrete code (→ other tickets):**
- **Yield** (`__piGoalActive`/`__piWayfindGrill` double-drive guard) = the open **[04](04-sync-timing-and-lifecycle.md)** design question. Underspecified here: no plan-context-injection exists to gate (only publish+gate+seed); `session_start` refresh+seed are already correctly scoped (seed fires only when the todo is empty, before any goal is active). Resolve 04 via grilling, then a small follow-up.
- **[05](05-multi-plan-representation.md)** multi-plan (deferred — single active-effort heuristic suffices).
- **[08](08-wayfind-migrates-to-writing-plans-format.md)** wayfind's `flattenTicketsToPlan` still emits legacy `### Phase N — [stem]`; migrating to writing-plans `### Task N:` makes wayfind-GENERATED `task_plan.md` feed the loop (currently only hand-authored writing-plans verified by TB6).

## Inputs (the spec = settled design)

- [01](01-revert-skill-edits-restore-fidelity.md) — invariant: skills untouched.
- [02](02-unified-coordination-layer.md) — home: inside goal-todo; format: writing-plans; Task≡phase.
- [03](03-seam-name-unification.md) — seam contract: 3 `__piPlan*`; internal-call self-consume.
- ADR-0003 — the manual stopgap this automates.
- Companions: [04](04-sync-timing-and-lifecycle.md) (timing — decide within the build), [08](08-wayfind-migrates-to-writing-plans-format.md) (wayfind emits writing-plans format — for wayfind-driven flows).
