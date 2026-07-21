---
type: grilling
status: closed
claimed: pi-agent
---

# 02 — Unified coordination layer: where it lives + what it parses

## Question

Where does the single coordination layer LIVE — its own extension (`pi-agent-ext-plan-coordinator`)? inside `pi-agent-ext-goal-todo`? inside `pi-agent-ext-superpowers`? inside `pi-agent-ext-wayfind`? — and how does it parse BOTH plan conventions (superpowers' writing-plans output AND wayfind's `task_plan.md`) into one phase/step model that publishes `__piPlan*`?

Reconcile two prior framings: the older effort's "coordination layer inside the superpowers ext, parses `docs/superpowers/plans/`" (decisions 02/04) vs build-plan-coordinator's "standalone, parses `task_plan.md`, widget slot order=3". The unified answer subsumes both.

### Context

- Existing consumers coded + waiting on `__piPlan*`: `goal.ts` (`planningGateBlocking`, `planProgressLineFromPeer`), `chain.ts` (`syncChainState`), `coordination.ts` (`readPlanIncomplete` / `readPlanSummary`).
- Cross-ext state is publish/subscribe via globalThis, NOT direct import (jiti dual-instance hazard, verified in older 02) — the layer publishes; goal-todo reads + mutates its OWN store.
- goal-todo's composite widget `addSection()` model (goal=0, todo=1, wayfind=2, plan-coordinator=3) — slot 3 is the layer's home if it renders.

## Resolution (closed 2026-07-19 — pi-agent; 3 grills, user decisions)

**Home:** the unified coordination layer lives **inside `pi-agent-ext-goal-todo`** (NOT a new package — user choice over the recommended own-extension). goal-todo's plan-coordination subsystem parses plans + drives its own `/goal`/`todo` directly (no seam for that path); goal-todo still publishes `__piPlan*` for **wayfind** to read (`chain.ts` `syncChainState`, `coordination.ts`). The composite-widget "slot 3 = plan-coordinator" framing **changes**: plan progress renders within goal-todo's own sections (or a goal-todo-owned slot), not a peer package. README/CONTEXT.md "peer" language → update to "goal-todo subsystem."

**Parse strategy:** **converge to a single canonical format** (user choice over support-both).

**Canonical format:** **superpowers writing-plans format** (`# [Feature] Implementation Plan`, `**Goal:**`, `### Task N:`, `- [ ] **Step N:**`) — user: "prefer superpower format, let wayfinder adjust."

**Model mapping (preserves the phase infrastructure):** writing-plans' `### Task N` ≡ a **phase**; its `- [ ] Step` ≡ steps. So `__piPlanPhases` readers + the phase model survive; only the FILE FORMAT converges. Each Task carries the wayfind `[NN-slug]` ticket reference in its header so `/wayfind sync`'s ticket-close loop still works.

**Consequences → new/updated tickets:**
- **[08](08-wayfind-migrates-to-writing-plans-format.md)** (new, task): wayfind `/wayfind seed` + `buildPlanSeed`/`seedPlan`/`chain.ts` emit writing-plans format (Task≡phase, `[NN-slug]` ref); rewrite `plan-seed-contract.test.ts` to pin writing-plans tokens. Blocked by [03](03-seam-name-unification.md).
- **[03](03-seam-name-unification.md)** reframed: define the `__piPlan*` seam contract under writing-plans-canonical + Task≡phase (publish from goal-todo; wayfind reads); supersede the older `__piSuperpowersPlan*`/`__piApplyTodoToggle` design.
- `plan-seed-contract.test.ts` BREAKS (pins old format) → rewritten in 08.
- map fog "plan-format convergence" → RESOLVED (writing-plans canonical); graduates to 08.
