# 05 — Slim core-task always-on footprint: gate ask_user_question + todo (#5)

**Status:** IN PROGRESS — branch `fix/core-task-gate-ask-user-todo`.

## Context

Part of effort `2026-08-08-fix-subagent-spawn-seam-tool-gate-core-task`. Optimization **#5** (was DEFERRED; now picked up). Predecessors all shipped: #1 active-set threading (#1127), #2 tool-gate `ensureSeeded`, #3 state-isolation stages 1-3 (#1132/#1133/#1135); #3 stage 4 (goalState) deferred to its own effort (ticket 03).

## Problem

core-task declares three tools `gating:{ core: true }` (always-on, never keyword-gated): `ask_user_question` (604 tok), `todo` (448 tok), `goal_complete` (99 tok). Measured against the gated parent baseline (30 tools / 10,579 tok — `bun-apps/pi-agent-cli/baselines/schema-cost-baseline.json`):

| tool | approxTokens | descLen | paramsLen |
|------|------|------|------|
| ask_user_question | 604 | 889 | 1525 |
| todo | 448 | 392 | 1401 |
| goal_complete | 99 | 151 | 243 |

`ask_user_question` + `todo` together = **~1,052 tok ≈ 10% of the always-on baseline**, and are the #1/#2 most expensive core-task tools. Because stages #1 (thread parent active set into child) and #2 (child gate seeds `sticky` from `effectiveCore`) are now in place, this always-on cost is ALSO paid by every spawned subagent — so slimming the core footprint compounds across fan-out.

`goal_complete` (99 tok) is negligible and stays core.

## Decision — gate, not trim

Gate (move out of `core:true` → keyword-gated) rather than schema-trim:
- The gating win is **structural** (the tools leave the always-on schema entirely) and **compounds to children**.
- Trimming `paramsLen` would touch the tool APIs for a smaller win with behavior risk.
- Keyword-gated tools are **recoverable** via `enable_tool` if a miss occurs.

## Change

Tool-gate consumes the `gating` field at `pi-agent-ext-tool-gate/extensions/tool-gate.ts:118` (`if (g.core === true)` → core set; otherwise → single-name gate). Removing `core:true` moves the tool from always-active `core` to keyword-gated `gates` — exactly the intended "lightly gated" behavior.

1. `pi-agent-ext-core-task/src/ask-user/ask-user-question.ts:74`:
   `gating: { core: true }` → `gating: { keywords: ["ask", "question", "questions", "clarify", "clarifying", "ambiguous", "ambiguity", "preference", "preferences", "choose", "choice", "decide", "decision", "option", "options", "recommend", "recommendation", "confirm"] }`
2. `pi-agent-ext-core-task/src/todo/todo.ts:37`:
   `gating: { core: true }` → `gating: { keywords: ["todo", "todos", "task", "tasks", "checklist", "track", "tracking", "progress", "step", "steps", "plan", "milestone", "pending", "done", "complete", "status"] }`

Keyword lists are CANDIDATES — must be validated by `qa:miss` (below) before merge.

## Safety

- **Orthogonal** to the session_start/child constraint (the effort map's red line): #5 touches only `gating` declarations, never session lifecycle.
- Residual risk = **availability**: `ask_user_question` is the agent's only structured clarifying mechanism; `todo` is used heavily mid-task. Mitigation = careful keyword design + tool-gate QA miss-rate validation + `enable_tool` fallback.

## Validation (gate before merge)

- `( cd bun-apps/pi-agent-ext-tool-gate && bun run qa:miss )` — confirm gating ask_user_question + todo does NOT spike miss-rate vs baseline (this is the go/no-go gate).
- `( cd bun-apps/pi-agent-ext-tool-gate && bun run qa:savings )` — confirm ~1,052 tok/turn saving (+ child compounding).
- `( cd bun-apps/pi-agent-ext-core-task && bun test )` and `( cd bun-apps/pi-agent-ext-tool-gate && bun test )` — green.
- Find and update any test asserting ask_user_question / todo are `core:true`.
- Confirm the always-on core baseline drops by ~1,052 tok.

## Out of scope

- `goal_complete` (99 tok — not worth it).
- Schema-trimming `paramsLen` (separate, lower priority).
- Re-enabling `session_start` in children (blocked on goalState stage 4, ticket 03).

## Status

IN PROGRESS — branch `fix/core-task-gate-ask-user-todo`.
