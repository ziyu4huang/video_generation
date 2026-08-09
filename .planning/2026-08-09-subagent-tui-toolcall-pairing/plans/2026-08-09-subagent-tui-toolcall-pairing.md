# Plan: subagent TUI tool-call/result pairing

TDD. Each task: failing test -> implement -> green -> commit.

## Task 1 -- Thread toolCallId through AgentHistoryEntry
- Add `toolCallId?: string` to `AgentHistoryEntry` (src/agent-history.ts).
- Populate in `compactAgentHistory`: from `block.id` for toolCall blocks; from `message.toolCallId` for toolResult messages.
- Test: a batched transcript (N calls grouped, then N results grouped) compacts so each result entry carries the id matching its OWN call (not the last call's).

## Task 2 -- matchedCallArgsFor pairs by id
- src/tool-action-label.ts `matchedCallArgsFor`: prefer the call whose `toolCallId === entry.toolCallId`; fall back to nearest-preceding-same-name when id is absent.
- Regression test (the exact symptom): batched [read PRD, read chromadb, read map] calls + [result, result, result] -> each result labels its OWN file. Pre-fix: all 3 -> "map.md". Post-fix: PRD / chromadb / map.
- Also fix formatSubagentTrace (src/subagent-tool.ts) call/result pairing to key off toolCallId (currently pairs call with next result WITHOUT checking toolName -> mis-pairs under batching).

## Task 3 -- Verify trace renderers + suite
- formatSubagentLive / formatSubagentTrace / formatHistoryLine now show correct per-result labels for batched runs.
- ( cd bun-apps/pi-agent-ext-subagent && bun test ) fully green (538+).
- ( cd bun-apps/pi-agent-ext-tool-gate && bun run qa ) still green (in case it consumes matchedCallArgsFor).

## Task 4 (optional, follow-up) -- suppress standalone result double-line
- Port renderedToolResults Set guard into the inline expanded renderer so a result already shown under its call is not re-emitted as a standalone line. Display-taste decision; defer unless requested.
