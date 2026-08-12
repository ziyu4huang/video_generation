---
type: task
status: closed
blocked by: 08
findings: H5
resolved: 2026-08-12 — shipped in #1133 + #1135 — todo store + loopState keyed by sessionId. Residual: goalState stage-4 isolation deferred → sibling effort `2026-08-08-fix-subagent-spawn-seam-tool-gate-core-task` ticket 03 stage 4
---

# 16 — Key session-scoped core-task state by sessionId (in-process subagent cross-contamination)

## Problem

pi's native lifecycle is one-session-per-process, so core-task's module-singleton
state (todo store `let state`, goal state, `globalThis.__piGoalActive` / `__piPlan*`)
is safe. BUT this repo's in-process subagent path (`WorkflowAgent.run` ->
`createAgentSession` in `pi-agent-ext-subagent`) runs a SECOND AgentSession in the
SAME process, sharing these singletons. A subagent that calls the todo tool (or
exercises goal machinery) reads/writes the PARENT session's state — cross-session
contamination. The `session_start` reset race does NOT occur (subagents skip
`bindExtensions`), but the shared-cell contamination is a real correctness hole.

## Evidence (from ticket 08 research)

- pi core: one active session/process, sequential teardown->create
  (`dist/core/agent-session-runtime.js` teardownCurrent/apply).
- In-process subagent: `bun-apps/pi-agent-ext-subagent/src/agent.ts:479-489`
  (`createAgentSession`, no fork); `subagent-in-flight.ts:45` ("process-local").
- Shared singletons: `src/todo/state/store.ts` (`let state`), `src/goal/state.ts:141`
  ("One instance per process"), `extensions/core-task.ts:49,57-60` (globalThis assigns).

## Approach (pick one via ADR)

1. Key the store by sessionId: `Map<sessionId, TaskState>`; thread sessionId into
   getTodos/commitState/replaceState; likewise goal/state.ts. (Principled.)
2. Move state into the per-session context / a `WeakMap<AgentSession, …>`,
   eliminating the module singleton. (Cleanest; more call sites.)
3. Exclude core-task from in-process subagent sessions (pass `excludeTools` /
   stripped resourceLoader in `agent.ts:479`). (Pragmatic; removes todo/goal
   from subagents entirely.)

## Acceptance

- [ ] Option chosen + recorded as an ADR.
- [ ] A subagent's todo/goal operations no longer touch the parent session's state
      (cross-session isolation test passes).
- [ ] pi's native one-session-per-process path unchanged (no regression).

## Notes

Spawned by ticket 08's research. Low-to-moderate severity in practice (subagents
rarely manipulate the parent's todo/goal), but a real correctness hole given
in-process subagents are a primary dispatch mechanism. Refs: ticket 08.
