**ID:** `ADR-wayfind-0003` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# ADR-0003: Plan coordinator — designed, not built (goal/todo driven manually for now)

Date: 2026-07-19
Status: Superseded — the coordinator was BUILT (see Update below). The
`__piWayfindActive` seam this ADR's prose assumes a plan coordinator would
read was also later removed as dead output (see
[ADR-0006](./0006-delete-wayfind-active-coordination-seam.md)).

## Update (2026-07-21) — the coordinator is now built

The coordinator this ADR parked as "designed, not built" was subsequently built as **`pi-agent-ext-task`** (the `goal-todo` package, renamed). It publishes all three `__piPlan*` seams on `globalThis`:

- `pi-agent-ext-task/extensions/task.ts:56-58` — `__piPlanPhases` / `__piPlanIncomplete` / `__piPlanSummary`
- contract-pinned by `pi-agent-ext-task/__tests__/extension-contract.test.ts` ("publishes `__piPlan*` coordination seams on globalThis")
- end-to-end wired with wayfind: commit `501e59f5` ("align syncChainState status token to 'completed' (09 tracer-bullet 6 / e2e)")

Consequences of the build: the "graceful no-ops" recorded below are **no longer no-ops when `ext-task` is loaded** — `/wayfind sync` now closes tickets whose phase reports `completed`, and `goal_complete`'s `planningGateBlocking()` now gates on `__piPlanIncomplete`. The manual skill-layer protocol (the original Decision) remains the graceful fallback for when `ext-task` is absent, but is no longer the only path. The rest of this ADR is preserved verbatim as the historical record of the pre-build state.

## Context

The `goal ↔ plan ↔ todo` three-layer coordination model is described in two `CONTEXT.md` files (ext-task, wayfind) and the wayfind README as a live runtime: a "plan coordinator" (the phase layer) parses `task_plan.md`, drives/tracks phases, publishes `globalThis.__piPlanPhases` / `__piPlanIncomplete` / `__piPlanSummary`, yields to an active `/goal` or grill, and feeds `/wayfind sync` + `goal_complete`'s phase-gate.

grep-verified reality: the coordinator was **designed but never built**.

- No package publishes the `__piPlan*` seams — zero publishers across ts+js, including `pi-agent-cli` and `pi-agent-ext-power-tool`; wayfind (`chain.ts`, `coordination.ts`) and ext-task (`goal.ts`) only read them.
- `isExternalDriverActive`, the "injection yielded" status string, and plan-injection / auto-continue logic do not exist in code (comments only).
- `goal_complete`'s phase-gate `planningGateBlocking()` reads `__piPlanIncomplete` → `typeof fn !== "function"` → always `undefined` → never blocks.
- The composite status widget (`status-widget.ts`) reserves slot order=3 for "the plan coordinator" — no package registers a section there.

All cross-layer coordination is therefore **graceful no-ops**: the system never fails, it silently does nothing. This hid the gap — the 2026-07-19 "improve wayfind extension" effort ran the full chart→ship flow without ever setting a `/goal` or `todo`; `goal_complete` returned "no active goal".

## Decision

Drive the two WORKING TUI layers (`/goal` + `todo`) **manually at the skill layer** until the coordinator is built. The hand-off skills now instruct the agent to: (1) prompt the user to `/goal <objective>` at hand-off; (2) seed `todo` entries from the plan; (3) drive them through execution; (4) call `goal_complete` at verified completion.

Key asymmetry: `/goal` is a TUI command with no agent-side setter (the agent can only prompt the user + call `goal_complete`); `todo` and `goal_complete` are agent tools.

## Consequences

- `/wayfind sync` and `goal_complete`'s phase-gate remain no-ops until the coordinator exists (graceful — no breakage).
- Manual skill-layer driving is enough to light up the goal+todo widgets and make `goal_complete` closeable.
- Building the coordinator (Option B) is a separate effort: parse `task_plan.md`, drive phases, publish the three `__piPlan*` seams, register widget slot order=3, wire `/wayfind sync` + the `goal_complete` gate. Tracked as a decision ticket on the wayfind map.
- Future option: promote the manual protocol to a canonical `driving-goal-and-todos` skill if it proliferates.
