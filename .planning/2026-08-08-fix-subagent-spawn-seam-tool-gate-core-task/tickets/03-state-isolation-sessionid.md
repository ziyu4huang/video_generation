# 03 — sessionId-keyed state isolation for core-task/accumulator (#3, = core-task ticket #16)

**Status:** STAGES 1-3 DONE (accumulator #1132, todo #1133, loop #1135); stage 4 (goalState) DEFERRED to a dedicated effort (high-risk/low-reward — see Progress).

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

## Progress
- Stage 1 (power-tool accumulator): DONE — PR #1132 (commit cf265a73). Map-per-sid + "" fallback; hooks/inspect_pathology threaded; session_shutdown cleanup. warning.ts dedup deferred.
- Stage 2 (core-task todo store): DONE — PR #1133 (commit 6925c11a). Map-per-sid with renderSid-default trick (no-arg accessors → parent/display bucket; execute threads ctx sid). Renderer/overlay/command call sites unchanged.
- Stage 3 (core-task loopState): DONE — PR #1135 (commit 35b20afc). Map-per-sid + renderSid-default (mirrors todo); ~70 loop.ts sites converted; no owned timer (borrows goal heartbeat).
- **Stage 4 (core-task goalState): DEFERRED — dedicated effort.** High-risk/low-reward: ~250 `goalState.X` sites in `goal.ts` (1500+ lines, the most complex core-task file) + two live `setInterval`s on the singleton (`heartbeatTimer`, `statusRefreshTimer`) + a module `quotaRetryTimer` + a process-singleton `piRef`. Correct isolation needs per-sid timer maps + per-sid `piRef` (the heartbeat closure captures 5 state fields at tick time; retrofitting timers after naive keying is where bugs hide). The bug it fixes (a subagent's `goal_complete`/`startGoal` clobbers the parent's goal) is low-frequency — subagents rarely drive goals. The documented ticket-#16 CAVEAT was the TODO store (fixed in stage 2). Design is ready (full Map-per-sid is the only correct fix — subset keying / scope-helper are insufficient): stage as (a) key the data fields, (b) per-sid timer maps + piRef, with isolation + heartbeat-fires-for-correct-sid + disarm tests. Reopen when core-task goal machinery is stable and a dedicated test window exists.
