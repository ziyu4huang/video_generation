# Ticket 02 — `agentCounts(agents)` single derivation

> Wave 1 · spec §2.2 · status: **done** — PR #1376 (squash-merged)

## Goal

Replace the per-site `agents.filter((a) => a.status === …)` copies with one exported
`agentCounts(agents)` helper (natural home: `display.ts` beside `recomputeWorkflowSnapshot`,
`display.ts:81–87`). Converging sites:

- `workflow-ui.ts:110–115` (`NavigatorModel.runs()` done/total)
- `workflow-ui.ts:215–218` (`persistedToSnapshot` rollup counters — derive once)
- `workflow-commands.ts:33–34` (`summarizeRun` done/total)
- `workflow-commands.ts:40–43` (`oneLineProgress` done/running/errs)
- `task-panel.ts:242–243` (`renderPanel` done/total)
- `workflow-manager.ts:65–68` (`workflowPreview` finished/total)

Snapshot rollup counters derive **once**; sites needing different status subsets (e.g.
`workflowPreview`'s done+error+skipped) take a parameter, not a copy. Same-file satellites
(`workflow-ui.ts:155`, `task-panel.ts:327–330`, `task-panel.ts:386`) ride along where the helper
fits.

## Acceptance criteria

- One `agentCounts` helper; all listed sites call it; no remaining per-site status-filter count
  in the listed functions.
- `persistedToSnapshot` counters and `recomputeWorkflowSnapshot` counters come from the same
  derivation.
- Regression test: count consistency — the same agents array through every converged site yields
  identical counts; rollup counters equal helper output.
- Rendered output byte-identical; existing tests green.
- Gate: `( cd bun-apps/pi-agent-ext-workflow && bun run test )`.

## Files

- `bun-apps/pi-agent-ext-workflow/src/display.ts` (helper; likely refactor of `recomputeWorkflowSnapshot`)
- `bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts`
- `bun-apps/pi-agent-ext-workflow/src/workflow-commands.ts`
- `bun-apps/pi-agent-ext-workflow/src/task-panel.ts`
- `bun-apps/pi-agent-ext-workflow/src/workflow-manager.ts`
- `bun-apps/pi-agent-ext-workflow/tests/` (consistency regression)

## Done — PR #1376

Squash-merged 2026-08-15 — 7 files, +138/−45 (six src + `tests/workflow-display.test.ts`,
2 new tests under `describe("agentCounts (ticket 02)")`).
TDD proofs fired: failing-first (`agentCounts` export-not-found) → final gate
(biome + tsc + bun test) 1072 pass / 0 fail / 3 todo, rendered output byte-identical.
Drift from plan verbatim (behavior identical): Task 1 (#1371) had already moved
`persistedToSnapshot` into `run-persistence.ts`, so the rollup counters converged
there (as the plan's post-Task-1 line refs anticipated); `workflow-ui.ts phases()`
typed its `byPhase` map `WorkflowAgentSnapshot[]` instead of `AgentRow[]`
(tsc: `AgentRow.status: string` is not assignable to the helper's
`Pick<WorkflowAgentSnapshot, "status">`); the test file (dynamic-import style)
gained the plan's imports as a top-level static block with `it()` per file
convention plus a Biome import-order safe fix.
