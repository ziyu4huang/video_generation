# 03 — Decomposition boundary: to-tickets vs writing-plans

---
type: grilling
blocked by: 01
status: closed
claimed: pi-session (2026-07-21)
---

## Question

The **largest overlap** in the whole space. `to-tickets` (wayfind) and
`writing-plans` (superpowers) both turn a spec into executable units:

- `to-tickets` → tracer-bullet vertical slices under
  `.planning/<effort>/tickets/`, each declaring blocking edges, sized to one
  context window.
- `writing-plans` → a multi-step plan, "before touching code."

Both occupy "spec → decomposed, executable work."

**Concrete finding (from 01):** they currently write to *different* homes too.
`writing-plans` still targets `docs/superpowers/plans/` (the
`unified-planning-dir.patch` fork to `.planning/<effort>/plan.md` is not
applied); `to-tickets` targets `.planning/<effort>/tickets/`. So the two
decomposition skills don't just overlap conceptually — they're unconverged on
where their output lives. Any resolution must settle the home, not just the
trigger. Resolve the single home for this activity. Decide between:

- **分工 by output artifact / effort shape** — to-tickets owns the
  wayfinder-driven tracer-bullet flow; writing-plans owns the
  brainstorming-driven linear plan. State the rule that picks one.
- **One subsumes the other** — pick the canonical decomposition skill; the
  other refers to it or is retired.
- **Structural move** — to-tickets is arguably a *plan-phase* activity
  (decomposition), so it belongs in superpowers, not wayfind. Consider moving
  it across packages.

This is the decision most likely to produce a structural refactor — note any
"skill should move" conclusion for the map's fog to graduate. Grill one
question at a time; consult ticket 01 on upstream's decomposition path.

## Resolution

**Parallel coexistence — the two decomposition skills are each half of a
coupled decomposition+execution stack, so they cannot merge.** The decisive
fact (surfaced via ADR-0003, now superseded): each decomposition skill's output
*shape is dictated by its downstream executor's contract*.

- `to-tickets` → ticket graph (blocking edges) → flattened to `task_plan.md`
  phases → **`core-task` goal coordinator** (`__piPlan*` seams, `/goal` gating,
  `todo`, `goal_complete`, `/wayfind sync` closes tickets). Cross-session
  tracking, phase visibility.
- `writing-plans` → linear TDD task list (`plan.md`) →
  **`subagent-driven-development`** (fresh subagent per task, review between).
  Single-session skill orchestration, no coordinator.

Three settled decisions:

1. **Relationship — parallel coexistence.** Keep both stacks; do not merge.
   Merging would require unifying the execution models (make
   `subagent-driven-development` consume `task_plan.md`, or make the
   coordinator consume `plan.md`) — a large, out-of-scope change. Both
   execution models serve real, distinct needs (tracked multi-session vs
   focused single-effort).

2. **Structural归属 — no move.** `to-tickets` stays in wayfind: it is coupled
   to the `core-task` coordinator (a wayfind-ecosystem component) and to
   `/wayfind sync`; moving it to superpowers would orphan it from its executor
   and break the existing e2e flow. `writing-plans` stays in superpowers
   (coupled to `subagent-driven-development`). The wayfind README already
   claims "decompose" as a wayfind responsibility, so this is consistent.

3. **Home + trigger — inherit 02's decisions.** Both homes live under
   `.planning/<effort>/`: `writing-plans` → `plan.md` (converged by the patch
   decided in 02), `to-tickets` → `tickets/`. Different files is *correct* —
   they are different artifacts feeding different executors. The trigger
   follows 02's entry-path mutual-exclusion rule: `to-tickets` after `to-spec`
   (wayfind flow), `writing-plans` after `brainstorming` (superpowers flow).

**Closes the map's "structural skill moves" fog** — resolved as a firm NO.
**Unblocks the patch-convergence execution** fully (both 02 and 03 decided
convergence) — the downstream task (run `apply-patches.sh` + edit `to-spec`
description + bootstrap note) can be bundled. Ticket 04 (wayfinder vs
writing-plans scope) is now the upstream decision that sharpens the entry-path
trigger for both 02 and 03.
