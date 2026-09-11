Plan written to `.planning/2026-09-11-self-arc-24-ultracode-cc-parity/map.md` (ledger number 24, path already claimed — verified).

## Verification results (all six hypotheses checked against code this session)

| # | Hypothesis | Verdict | Key evidence |
|---|---|---|---|
| 1 | Pre-flight ceiling-confirm | **Real, feasible — ticket t02** | `effort-command.ts:5-11` self-charts it; `workflow-tool.ts:539-545` proves the tool path CAN await UI; caps known at `:572-576` |
| 2 | checkpoint yes/no only | **Real — ticket t01**; gap is rendering only | `workflow.ts:211-228` `CheckpointOptions` already has `kind:"confirm"\|"input"\|"select"` + `choices`; contract `workflow.ts:112` passes options; adapter `workflow-tool.ts:544-545` collapses to boolean |
| 3 | Persistent armed badge | **Rejected for arc (charted)** | Only run-scoped surfaces exist in ultracode; every always-on badge surface is pi-core (candidate-6 territory) |
| 4 | No per-history timestamps | **Real — ticket t03** | `AgentHistoryEntry` (`s2-agent-core-runtime/src/agent-history.ts:7-17`) has no `ts`; detail renders `historyLabel(entry): entry.text` (`workflow-ui.ts:420-424,445-452`); model per agent IS shown (`:412`) |
| 5 | Workflow-run steering | **Real, >1 ticket — seam only, ticket t04** | `agent-turns.ts:92-137` `SteeringCapableSession.steer` exists (arc-23); runtime never surfaces the session handle; `RunEvents.onAgentHistory` (`workflow.ts:129`) is the hook-shaped seam |
| 6 | Chart-only candidates | Confirmed pi-core | Named in Loop findings with anchors |

## Ticket set

- **t01** checkpoint-select dialog (probe-first: dialog push vs task-panel key capture)
- **t02** pre-flight ceiling-confirm at the tool boundary (resolves roadmap P1-5 #4; reuses t01's dialog)
- **t03** optional `ts` on `AgentHistoryEntry` + navigator duration line (core-runtime, backward-compatible)
- **t04** steering plumbing seam: `onAgentSession` RunEvents hook + `manager.steerWorkflowAgent()`, with an honest unreachable-exit
- **t05** verification leg — pinned immutable deploy (PB-08/09/10), throwaway scratch git repo with worktree-isolation + parent-clean assertions, 3 tui-drive scenarios, GLM-5.3 model proofs, receipts to `evidence/`
- **t06** close-out (ledger, cross-effort back-links to self-arc-23)

## Learnings applied

- **#1 (deployed ≠ source)** shaped t05: grep-assert distinctive symbols/strings in shipped bundles *before* driving — and since t03/t04 touch an *inlined* workspace package (`@repo/s2-agent-core-runtime`), the deploy-cache miss check is called out as load-bearing, with the risk written into the map.
- **#4/#5 (TUI drive discipline)** baked into t05 steps verbatim: `TERM=xterm-256color`, ~64-byte chunks, DA reply `\x1b[?1;2c` + kitty silence, real wall-clock sleeps after dialog mount (first-keypress-eaten), settle judged only on live markers.