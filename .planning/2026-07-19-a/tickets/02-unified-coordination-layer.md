---
type: grilling
status: open
---

# 02 — Unified coordination layer: where it lives + what it parses

## Question

Where does the single coordination layer LIVE — its own extension (`pi-agent-ext-plan-coordinator`)? inside `pi-agent-ext-goal-todo`? inside `pi-agent-ext-superpowers`? inside `pi-agent-ext-wayfind`? — and how does it parse BOTH plan conventions (superpowers' writing-plans output AND wayfind's `task_plan.md`) into one phase/step model that publishes `__piPlan*`?

Reconcile two prior framings: the older effort's "coordination layer inside the superpowers ext, parses `docs/superpowers/plans/`" (decisions 02/04) vs build-plan-coordinator's "standalone, parses `task_plan.md`, widget slot order=3". The unified answer subsumes both.

### Context

- Existing consumers coded + waiting on `__piPlan*`: `goal.ts` (`planningGateBlocking`, `planProgressLineFromPeer`), `chain.ts` (`syncChainState`), `coordination.ts` (`readPlanIncomplete` / `readPlanSummary`).
- Cross-ext state is publish/subscribe via globalThis, NOT direct import (jiti dual-instance hazard, verified in older 02) — the layer publishes; goal-todo reads + mutates its OWN store.
- goal-todo's composite widget `addSection()` model (goal=0, todo=1, wayfind=2, plan-coordinator=3) — slot 3 is the layer's home if it renders.
