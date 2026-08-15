> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Effort: subagent TUI tool-call/result pairing (trace fidelity)

- Status: Done (shipped #1161)
- Date: 2026-08-09
- Scope: bun-apps/pi-agent-ext-subagent

## Problem
The subagent inline trace (foreground dispatch, expanded view) renders misleading, apparently-duplicated tool-result lines. Observed live: three identical `✓ Read map.md` lines for a single dispatch — looks like noise / "useless message".

## Root cause (investigated, line-level)
LABELING BUG, NOT repeated reads. The child issued 3 DISTINCT reads (`PRD.md`, `chromadb-consolidation.md`, `map.md`) BATCHED in one assistant turn. `compactAgentHistory` preserves order, so the transcript is [call,call,call,call] then [result,result,result,result]. The result labeler `matchedCallArgsFor` (`src/tool-action-label.ts` ~L327-340) does a nearest-preceding-same-`toolName` backward scan, so ALL 3 read RESULTS resolve to the LAST read CALL (`map.md`) -> three `✓ Read map.md`.

Underlying defect: `AgentHistoryEntry` carries no `toolCallId` (`src/agent-history.ts` type); `compactAgentHistory` drops `block.id` (call) and `message.toolCallId` (result). Pairing by toolName alone is ambiguous under batching.

Secondary noise: the inline expanded renderer `formatSubagentTrace` (`src/subagent-tool.ts` ~L388-401) renders each completed tool as TWO lines (call + result), unpaired. Only a 16-line tail cap exists; no dedup. NB: do NOT collapse identical lines naively -- the 3 identical lines here are 3 DIFFERENT real reads, mislabeled; collapsing would hide two real file reads.

## Proposed design
Port the upstream (`/Users/huangziyu/proj/pi-subagents-lite/src/ui/conversation-viewer.ts`) id-keyed pairing pattern:
1. Thread `toolCallId?: string` through `AgentHistoryEntry`; populate from `block.id` (toolCall) and `message.toolCallId` (toolResult) in `compactAgentHistory`.
2. In `matchedCallArgsFor`, prefer the call whose `toolCallId === entry.toolCallId`; fall back to nearest-preceding-same-name for legacy/missing ids. Also fix `formatSubagentTrace` call/result pairing to key off id.
3. (Optional, follow-up Task 4) suppress the standalone result line when already rendered inline with its call, mirroring the lite `renderedToolResults: Set<string>` guard -- reduces the call/result double-line noise. Deferred; display-taste decision.

## Non-goals
- Runtime gating / dispatch behavior.
- Widget architecture (context-box vs inline).
- The pre-existing TS18048 narrowing cluster (separate follow-up).

## Upstream reference
pi-subagents-lite conversation-viewer.ts: id-keyed `toolResults` Map (~L654-657), per-call result lookup by id (~L599), `renderedToolResults` Set suppression (~L577, L609, L662).
