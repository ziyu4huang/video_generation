> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
---
effort: 2026-07-19-build-plan-coordinator
superseded-by: 2026-07-19-a
---

# Map — build the plan coordinator (Option B)

## Destination

Implement the **plan coordinator** — the missing middle (phase) layer of the `goal ↔ plan ↔ todo` three-layer coordination model — so the cross-layer wiring that is today graceful no-ops becomes real runtime behavior: `task_plan.md` phases get driven/tracked, the three `__piPlan*` seams get published, `goal_complete`'s phase-gate actually gates, `/wayfind sync` actually closes tickets, and the composite widget's reserved slot (order=3) gets a section. This replaces the manual skill-layer stopgap (ADR-0003 / effort `2026-07-19-goal-todo-handoff-stopgap`, PR #678) with automated coordination.

## Notes

**Why this exists:** ADR-0003 (`pi-agent-ext-wayfind/docs/adr/0003-plan-coordinator-designed-not-built.md`) records — with grep evidence — that the coordinator was designed (reserved widget slot order=3, four `globalThis` seam keys, a contract test, two `CONTEXT.md` entries, a README runtime description) but **never built**. The 2026-07-19 goal/todo hand-off stopgap (PR #678) compensates by driving goal/todo manually at the skill layer; this effort removes the need for that compensation.

**Domain:** the coordination seam already has two publishers working — `pi-agent-ext-goal-todo` (`__piGoalActive`) and `pi-agent-ext-wayfind` (`__piWayfindActive` / `__piWayfindGrill`). The coordinator is the THIRD publisher (of `__piPlanPhases` / `__piPlanIncomplete` / `__piPlanSummary`), plus the consumer of `task_plan.md` + the two existing seams.

**Consumers already coded — reading nothing today (they light up the moment a publisher appears):**
- `pi-agent-ext-goal-todo/src/goal/goal.ts` — `planningGateBlocking()` (the `goal_complete` gate) + `planProgressLineFromPeer()` (status line).
- `pi-agent-ext-wayfind/src/chain.ts` — `syncChainState()` (the `/wayfind sync` ticket-closing loop).
- `pi-agent-ext-wayfind/src/coordination.ts` — `readPlanIncomplete` / `readPlanSummary`.

**Standing prefs:** PLAN-FIRST; HONESTY OVER FACE-SAVING; conversation zh-TW, artifacts English; **preserve the graceful-seam design** (globalThis process-singleton, no-op when a peer is absent — never hard-couple the packages).

## Decisions so far

- [01 — Build the plan coordinator](tickets/01-build-plan-coordinator.md) — **closed, superseded** by [`2026-07-19-a`](../2026-07-19-a/map.md): coordinator lives inside goal-todo (decision 02), `__piPlan*` seam contract pinned (decision 03), build = 2026-07-19-a/09. This effort's "Not yet specified" fog is resolved by those decisions.

**Frontier: (empty — effort superseded by `2026-07-19-a`)**

## Not yet specified

<!-- fog — the open sub-decisions a grill of ticket 01 must resolve before build -->

- **Where the coordinator lives.** Its own extension (`pi-agent-ext-plan-coordinator`)? Inside `pi-agent-ext-goal-todo` (already owns `/goal` + the composite widget)? Inside `pi-agent-ext-wayfind`? The README describes it as a peer that "yields" — implying a separate package — but goal-todo already co-locates goal + widget.
- **Phase-driving mechanism.** How are `task_plan.md` phases advanced? A new `/plan` command + agent-driven status writes? Auto-detect from executing-plans checkpoints? A `task_plan.md` parser reading the `**Status:**` tokens the contract test pins?
- **Completion detection.** What marks a phase `complete` so `syncChainState` closes its ticket? Agent writes status? A verification gate (ties into superpowers' verification-before-completion)?
- **Command surface.** Does the coordinator add commands (`/plan status`, `/plan next`)? How does it coexist with `/wayfind sync` + `/goal` without double-driving (the yield logic)?
- **Widget section.** What does slot order=3 render (phase progress)? Reuse the composite-widget `addSection` API (`status-widget.ts`).

## Out of scope

- **⚠️ SUPERSEDED by [`2026-07-19-a`](../2026-07-19-a/map.md)** — the missing middle layer is built inside goal-todo as the unified coordination layer (decisions 02+03; build = 2026-07-19-a/09), not as the separate package / Option-B shape this map assumed. This map is retained for history. See [2026-07-19-a/06](../2026-07-19-a/tickets/06-close-and-supersede-prior-efforts.md).
- **Re-litigating the stopgap.** ADR-0003 + PR #678 stand; this effort automates *around* them, not by reverting them. The manual skill-layer protocol stays as the graceful fallback for when the coordinator is absent.
- **Changing the seam contract.** The four `globalThis` keys + the `task_plan.md` format tokens are pinned by `plan-seed-contract.test.ts` and consumed by three packages — this effort publishes against the existing contract, not rewrites it.
