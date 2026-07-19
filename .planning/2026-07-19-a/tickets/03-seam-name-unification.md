---
type: grilling
status: closed
claimed: pi-agent
blocked by: 02
---

# 03 — Seam-name unification: `__piSuperpowersPlan*` → `__piPlan*`

## Question

The older effort designed `__piSuperpowersPlan` / `__piApplyTodoToggle` / `__piSuperpowersPlanIncomplete`; the existing readers (`goal.ts`, `coordination.ts`) and build-plan-coordinator use `__piPlanPhases` / `__piPlanIncomplete` / `__piPlanSummary`. Unify on the `__piPlan*` names the readers ALREADY expect, and reconcile the older effort's bidirectional toggle (`__piApplyTodoToggle`, todo→plan completion) with `__piPlanPhases` (phase status)? Define the final seam contract (keys + signatures) the one layer publishes.

### Context

- Older 04 baked a master-split: structure = plan-master (plan→todo), completion = todo-master (todo→plan via `__piApplyTodoToggle`). Decide whether that split survives under `__piPlan*` naming, or collapses into phase-status-only.

**Context update (post-[02](02-unified-coordination-layer.md)):** the layer lives **inside goal-todo** and publishes `__piPlan*` for wayfind to read; the canonical plan format is **writing-plans** (Task≡phase). So this ticket now defines the `__piPlan*` contract under that model (goal-todo publishes; wayfind reads via `chain.ts`/`coordination.ts`) and **supersedes** the older `__piSuperpowersPlan*` / `__piApplyTodoToggle` design — one publisher (goal-todo), `__piPlan*` names, Task≡phase shape.

## Resolution (closed 2026-07-19 — pi-agent; 1 grill, contract code-pinned)

**Contract (pinned by existing readers — not a contested decision):** goal-todo publishes three `globalThis` seams, all consumed by wayfind:
- `__piPlanPhases(cwd) → PlanPhaseInfo[]` (`{id, status, ticketIds?}`) — wayfind `chain.ts:58` reads (`syncChainState`, closes tickets).
- `__piPlanIncomplete(cwd) → boolean` — wayfind `coordination.ts` reads (`readPlanIncomplete`, narration); goal-todo uses it for `goal_complete` gating.
- `__piPlanSummary(cwd) → string` — wayfind `coordination.ts` reads (`readPlanSummary`, status line); goal-todo uses it for progress display.

**goal-todo self-consume = internal-call** (user choice): goal-todo's `goal.ts` (`planningGateBlocking` / `planProgressLineFromPeer`) calls the layer's functions DIRECTLY — NOT via globalThis. goal-todo publishes `__piPlan*` to globalThis ONLY for wayfind. No self-publish-self-read. (Build refactors goal.ts's two readers to internal calls.)

**Task≡phase mapping** (from [02](02-unified-coordination-layer.md)): `PlanPhaseInfo.id` = writing-plans Task id; `ticketIds` = the `[NN-slug]` refs from Task headers.

**Superseded:** the older effort's `__piSuperpowersPlan*` / `__piApplyTodoToggle` design (never built) — dropped. One publisher (goal-todo), `__piPlan*` names, one-way to wayfind.

**Pattern:** follows `__piGoalActive` (direct `globalThis.X = ...` assignment; graceful no-op when the peer is absent).

**Newly unblocked:** [04](04-sync-timing-and-lifecycle.md) (timing/lifecycle), [05](05-multi-plan-representation.md), [08](08-wayfind-migrates-to-writing-plans-format.md).
