# Ticket 03 — RunView costUsd / tokensIn / tokensOut projection

> Wave 1 · spec §2 · status: **done** (PR #1414, 2026-08-15)

## Goal

Registry accrues child usage from `onUsage` callbacks (`spawn-subagent.ts:115–119`,
`AgentUsage` at `core-runtime/src/agent.ts:312–319`); `buildRunView` projects `costUsd`,
`tokensIn`, `tokensOut`; row tail renders `· $0.04` via `fmtCost`. Frozen at terminal state
(mirrors `elapsedFrozen`).

## Acceptance criteria

- RunView carries the three new readonly fields; live runs update per tick.
- Terminal runs freeze values (no post-terminal drift).
- Row tail shows cost only when > 0.

## Files

- `bun-apps/pi-agent-ext-core-runtime/src/run-view.ts` (+ builder)
- `bun-apps/pi-agent-ext-subagent/src/spawn-subagent.ts` / registry (usage accrual)
- `bun-apps/pi-agent-ext-core-runtime/src/agent-row-display.ts` (tail wiring, if here)

## Gate

`( cd bun-apps/pi-agent-ext-core-runtime && bun run typecheck && bun test )` +
`( cd bun-apps/pi-agent-ext-subagent && bun run test )`
