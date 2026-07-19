# Goal/Todo Hand-off Stopgap

## Problem

The `goal ↔ plan ↔ todo` three-layer coordination model is **architected but missing its middle layer**. The "plan coordinator" (phase layer) was designed — reserved composite-widget slot (order=3), four `globalThis` seam keys, a contract test pinning the `task_plan.md` format, two `CONTEXT.md` ubiquitous-language entries, and a README describing its runtime behavior — but **never implemented**. Evidence (grep-verified):

- No package publishes the `__piPlan*` seams — zero publishers across ts+js, including `pi-agent-cli` and `pi-agent-ext-power-tool`. `wayfind` (`chain.ts`, `coordination.ts`) and `goal-todo` (`goal.ts`) only **read** them.
- `isExternalDriverActive`, the status-bar "injection yielded" string, and plan-injection / auto-continue logic **do not exist in code** — only in comments.
- `goal_complete`'s phase-gate (`planningGateBlocking`) reads `__piPlanIncomplete` → `typeof fn !== "function"` → always returns `undefined` → never blocks.
- The composite status widget (`status-widget.ts`) reserves slot order=3 for "the plan coordinator" — no package registers a section there.

Consequence: all cross-layer coordination is **graceful no-ops** — the system never fails, it silently does nothing. Compounding this, the agent-facing skills (`wayfinder` / `to-tickets` / `grilling`; `writing-plans` / `executing-plans` / `subagent-driven-development` / `verification-before-completion`) **never instruct the agent to drive even the WORKING layers** (`/goal` + `todo` + `goal_complete`). grep: zero mentions of `/goal` / `goal_complete` / `todo` as Pi primitives (superpowers' "goal" hits are all generic English).

**Live reproduction:** the 2026-07-19 "improve wayfind extension" effort ran the full chart → grill → tickets → resolve → execute → ship flow without ever setting a `/goal` or creating a `todo`; `goal_complete` → "no active goal."

## Scope (this effort = Option A stopgap)

Drive the two WORKING TUI layers (`/goal` + `todo`) **manually at the skill layer** at the planning → execution hand-off, and record the missing middle layer as a deferred ADR. **Out of scope:** building the plan coordinator (Option B — separate effort with its own brainstorm/spec/plan cycle).

## Key asymmetry

- **`/goal`** is a TUI slash-command; the agent has **no tool to set it** (only `goal_complete` to close). So step 1 is a **user-prompt** (hand the user the exact command), not an agent action.
- **`todo`** and **`goal_complete`** ARE agent tools → direct actions.

## The 4-step hand-off protocol

1. **Set objective** — at the hand-off (destination settled), prompt the user to run `/goal <one-line destination>`.
2. **Seed todos** — create `todo` entries mirroring the execution units — the `task_plan.md` phases (from `/wayfind seed`), or the per-ticket `plans/<NN>-<slug>.md` files (from `writing-plans`), whichever the flow produced — one per unit, dependency-ordered.
3. **Drive todos** — through execution, mark each `in_progress → completed` as its unit lands.
4. **Close** — all todos completed + work verified → call `goal_complete`.

## Placement (natural-split)

| Step | Skill | Location |
|---|---|---|
| 1 `/goal` prompt | `pi-agent-ext-wayfind/skills/to-tickets/SKILL.md` | hand-off terminal (`/wayfind seed` / `--seed-plan` completion) |
| 2 seed todos | `pi-agent-ext-superpowers/skills/writing-plans/SKILL.md` | plan finalization |
| 3 drive todos | `executing-plans/SKILL.md` + `subagent-driven-development/SKILL.md` | per-unit completion (2–3 lines each) |
| 4 `goal_complete` | `verification-before-completion/SKILL.md` | after verified |
| caveat | ADR-0003 (new) | `pi-agent-ext-wayfind/docs/adr/0003-plan-coordinator-designed-not-built.md` |

Five skill edits (2–4 lines each) + one ADR. Each edit cites ADR-0003.

## Honest caveat (in each edit + ADR-0003)

> The plan coordinator (middle phase layer; would auto-drive phases, gate `goal_complete`, feed `/wayfind sync`) is **designed but not built** — `__piPlan*` seams are read by wayfind + goal-todo but published by nothing → graceful no-ops. This stopgap drives goal/todo manually at the skill layer until the coordinator is built (deferred — map ticket). Future option: promote the protocol to a canonical `driving-goal-and-todos` skill.

## Verification

- grep: every skill edit references `/goal` / `todo` / `goal_complete` / ADR-0003 consistently; no stale `__piPlan*`-as-working claims introduced.
- `pi-agent-ext-wayfind` `bun test` green; `pi-agent-ext-superpowers` `bun test` green (`skills.test` loads real `SKILL.md`).
- ADR-0003 self-consistent with the grep evidence (zero publishers, reserved slot, dead gate).

## Out of scope (deferred → Option B)

**Build the plan coordinator:** parse `task_plan.md`, drive/track phases, publish `__piPlanPhases` / `__piPlanIncomplete` / `__piPlanSummary`, register composite-widget slot order=3, and wire `/wayfind sync` + `goal_complete`-gating to actually fire. Own brainstorm/spec/plan cycle. ADR-0003 records this as the deferred follow-up and lists it as a decision ticket on the wayfind map.
