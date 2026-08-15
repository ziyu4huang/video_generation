# Ticket 01 — Subagents section in CoreTaskStatusWidget

> Wave 1 · spec §2 · status: **stub** (awaiting plan)

## Goal

Add a `subagents` section (order 4) to core-task's composite status widget: rows rendered via
`renderActivityRow` consuming `registry.views({ foreground: false })`; collapsed (renders
nothing) when the view list is empty. Follows `status-widget.ts:16–18` section-order contract
(goal=0/todo=1/wayfind=2/coordinator=3, subagents=4).

## Acceptance criteria

- Section renders live background-run rows; renders zero lines when empty.
- No duplication with the inline foreground line (exclusion rule, REVIEW §4).
- core-task imports registry/row fn via typed public surface (spec §1), no new globalThis seams.
- Row-render snapshots (empty / 1 run / N runs) green.

## Files

- `bun-apps/pi-agent-ext-core-task/extensions/core-task.ts` (addSection)
- `bun-apps/pi-agent-ext-core-task/src/subagents/` (new section module + tests)
- `bun-apps/pi-agent-ext-subagent/src/index.ts` (export registry access if missing)

## Gate

`( cd bun-apps/pi-agent-ext-core-task && bun run typecheck && bun test )` +
`( cd bun-apps/pi-agent-ext-subagent && bun run test )`
