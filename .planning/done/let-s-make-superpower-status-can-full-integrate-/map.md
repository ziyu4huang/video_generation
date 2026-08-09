---
effort: let-s-make-superpower-status-can-full-integrate-
created: 2026-07-19
last: 2026-08-09
status: complete
superseded-by: 2026-07-19-a
---

# Map — superpowers status ↔ goal-todo

## Destination

Superpowers methodology progress **auto-syncs into the goal-todo extension**: the `todo` list mirrors the active plan's steps, and `/goal` reflects the methodology goal (with `goal_complete` gated on verification) — driven by a **hard coordination layer** in the superpowers extension that parses a **convention-based plan file**. No edits to the byte-identical upstream skills.

## Notes

**Domain:** pi extensions. Two consumers — `pi-agent-ext-superpowers` (the source of methodology progress; stateless today) and `pi-agent-ext-goal-todo` (owns the `todo` tool, `/goal`+`goal_complete`, and the shared composite status widget).

**Three settled decisions (this effort's trunk — resolved in the charting grill):**

1. **Integration shape = skills drive the todo/goal tools** (NOT a status-widget section). Superpowers progress flows INTO goal-todo; goal-todo is not asked to render a superpowers section.
2. **Mechanism = hard (extension hooks)**, not soft agent-instruction. A coordination layer inside the superpowers ext performs the sync.
3. **Signal source = convention-based plan file** (known location + parseable format), not tool-call heuristics or context-message scanning.

**Key facts (already verified — don't re-litigate):**

- The superpowers ext is **stateless** today: skill discovery + bootstrap injection only. Skills are **byte-identical to upstream** and must NOT be edited (README invariant; biome excludes `skills/`; `skills.test.ts` asserts structural rules).
- Skills **never call any task tool** (grep 0 hits) and never call `goal_complete`/`/goal`. The methodology is **plan-file driven**: `writing-plans` writes `docs/superpowers/plans/YYYY-MM-DD-<feature>.md` with a `# [Feature] Implementation Plan` header + checkbox `- [ ] **Step N**` tasks. *(A pre-existing convention the hard layer can likely adopt.)*
- goal-todo owns the **shared composite status widget** (`pi-power-tool`, `addSection()` model: goal=0, todo=1, wayfind=2) — NOT a surface in scope here. Its todo **store exports a programmatic API**: `getTodos / getNextId / getState / replaceState / commitState`.
- **Module-identity gotcha (VERIFIED in [02](tickets/02-cross-ext-store-access.md)):** pi loads extensions via **jiti** (`createJiti`, Bun `try-native` fallback). A cross-extension `import` of goal-todo's store resolves to a DIFFERENT module instance → silent state split. The repo's universal fix is a `globalThis` coordination seam; **no peer imports goal-todo's store today.**
- **Cross-ext integration is publish/subscribe, NOT direct mutation (VERIFIED in [02](tickets/02-cross-ext-store-access.md)):** peers exchange state via `globalThis` function seams (`__piGoalActive`, `__piPlanIncomplete`, `__piPlanSummary`, `__piPlanPhases`) — one publishes, the other reads. `ExtensionAPI` has NO `invokeTool`/`callTool` (only `registerTool` + `setActiveTools`). → The coordination is **two-sided**: superpowers parses the plan + PUBLISHES; goal-todo reads + mutates its OWN store (so goal-todo must gain a subscriber — a scope addition).
- A **separate** plan convention exists for wayfind (`.planning/<effort>/{map.md, tickets/, task_plan.md}`) — a different methodology; treat as out of scope unless the convention ticket decides otherwise.

**Skills every session should consult:** `grilling`, `domain-modeling`, `writing-plans`, `executing-plans`, `verification-before-completion`.

## Decisions so far

<!-- the index — one line per closed ticket -->

- [01 — Plan convention](tickets/01-plan-convention.md) — adopt `writing-plans`' existing convention wholesale (`docs/superpowers/plans/`; header `# [Feature] Implementation Plan`→`/goal`, `- [ ] **Step N**` checkbox→todos); scope is location-driven & skill-agnostic; stable step-ID deferred to 04; soft-instruction near-free.
- [02 — Cross-ext store access](tickets/02-cross-ext-store-access.md) — direct cross-ext store import is UNSAFE (jiti dual-instance, verified); no tool-invoke API exists; use the repo's globalThis publish/subscribe pattern — superpowers parses+publishes, goal-todo reads+mutates its own store. Coordination is **two-sided** (goal-todo must gain a subscriber).
- [04 — Sync mapping](tickets/04-sync-mapping.md) — **bidirectional** with a clean master-split: structure=plan-master (plan→todo), completion=todo-master (todo→plan via `__piApplyTodoToggle`); title-hash step IDs; signals `__piSuperpowersPlan`/`__piApplyTodoToggle`/`__piSuperpowersPlanIncomplete`; `goal_complete` gated on plan-completion (verification stays soft); one-active-plan assumed (multi-plan → 06).
- [03 — Bootstrap soft-instruction](tickets/03-bootstrap-soft-instruction.md) — **closed, superseded (moot).** The unified layer lives in goal-todo and reads plans directly → zero skill editing / zero bootstrap nudge. Folded into 2026-07-19-a.
- [05 — Sync timing & lifecycle](tickets/05-timing-and-lifecycle.md) — **closed, folded** into 2026-07-19-a/04 (timing decision deferred to the build at 2026-07-19-a/09).
- [06 — Multi-plan representation](tickets/06-multi-plan-representation.md) — **closed, folded** into 2026-07-19-a/05.

## Not yet specified

<!-- all in-scope fog has graduated: conflict/ownership + goal_complete-gating resolved as decisions in [04](tickets/04-sync-mapping.md); multi-plan graduated to [06](tickets/06-multi-plan-representation.md). Currently empty. -->

## Out of scope

- **⚠️ SUPERSEDED by [`2026-07-19-a`](../2026-07-19-a/map.md)** — this effort's design (coordination layer inside superpowers, publishing `__piSuperpowersPlan*`) was reconciled into a single unified layer living inside goal-todo publishing `__piPlan*` (2026-07-19-a decisions 02+03). Tickets 03/05/06 closed & folded; this map is retained for history. See [2026-07-19-a/06](../2026-07-19-a/tickets/06-close-and-supersede-prior-efforts.md).
- **Editing the upstream superpowers skills** to add `todo`/`goal_complete` calls — violates the byte-identical fidelity invariant (README, biome, `skills.test.ts`). The bridge is built OUTSIDE the skills.
- **A superpowers status-widget section** in the goal-todo composite widget — explicitly rejected at the destination grill (shape B, not A).
- **Tool-call-heuristic or context-message-scan signal detection** — rejected at the signal-source grill in favour of the convention-based plan file.
- **Unifying with wayfind's `.planning/` ticket system** — a different methodology; ruled out unless the convention ticket reopens it.
