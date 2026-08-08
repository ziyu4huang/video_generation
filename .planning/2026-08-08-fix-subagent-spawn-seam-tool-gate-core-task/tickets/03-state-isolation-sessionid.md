# 03 — sessionId-keyed state isolation for core-task/accumulator (#3, = core-task ticket #16)

**Status:** DEFERRED

## Change
Key the process-global module singletons by sessionId: todo (`core-task/src/todo/state/store.ts`), goal (`src/goal/state.ts`), plan coordinator, loop state, and power-tool's pathology accumulator (`pi-agent-ext-power-tool/src/pathology/accumulator.ts`) — `Map<sessionId, State>` instead of a bare module `let`. Reset on each session's `session_start`.

## Why
In-process subagents share these singletons with the parent (same process, same module cache, child skips `session_start` reset). A subagent's `todo`/`goal_complete` mutates the PARENT's state; its tool calls pollute the parent's pathology buffer. This is the documented open core-task ticket #16 (`store.ts:5-14` CAVEAT).

## Prerequisite role
This is the GATE for ever safely firing `session_start` in children (the alternative to #2's surgical fix). Until singletons are session-scoped, firing `session_start` in a child wipes the parent.

## Verification (when implemented)
- A subagent that calls `todo` does NOT appear in the parent's todo list.
- Parent + child pathology accumulators are independent.
- All existing core-task + power-tool tests green.
