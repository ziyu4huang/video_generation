---
type: grilling
status: open
blocked by: 02
---

# 03 — Seam-name unification: `__piSuperpowersPlan*` → `__piPlan*`

## Question

The older effort designed `__piSuperpowersPlan` / `__piApplyTodoToggle` / `__piSuperpowersPlanIncomplete`; the existing readers (`goal.ts`, `coordination.ts`) and build-plan-coordinator use `__piPlanPhases` / `__piPlanIncomplete` / `__piPlanSummary`. Unify on the `__piPlan*` names the readers ALREADY expect, and reconcile the older effort's bidirectional toggle (`__piApplyTodoToggle`, todo→plan completion) with `__piPlanPhases` (phase status)? Define the final seam contract (keys + signatures) the one layer publishes.

### Context

- Older 04 baked a master-split: structure = plan-master (plan→todo), completion = todo-master (todo→plan via `__piApplyTodoToggle`). Decide whether that split survives under `__piPlan*` naming, or collapses into phase-status-only.
