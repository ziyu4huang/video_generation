# Ticket 09 — goalState per-session partition (closes ext-task #16)

Status: pending

## Why

`goalState` is a process-level module singleton (state.ts:149-152 CAVEAT);
under pi's one-session-per-process lifecycle that is safe, but in-process
subagent children (`createAgentSession`) share it — a child's
`agent_end`/`input` hooks can drive the PARENT's goal continuation
(ext-task ticket #16, still open). `todo` already solved the identical
hazard with per-sessionId buckets + `renderSid` (store.ts:21-66); goal
never got the treatment. Adjacent: `noProgressContinuations` /
`noProgressGoalId` are module-level `let`s OUTSIDE goalState
(hooks.ts:69-70), so `__resetGoalState()` misses them — violating the
"ALL session-scoped runtime state lives in goalState" contract (goal.ts:42).

## Scope

1. **Partition goalState by sessionId** mirroring todo's store shape:
   bucket map + a renderSid-style default bucket for ctx-less display code;
   hooks resolve the bucket from the event ctx's sessionManager id.
   Continuation/bookkeeping fields move into the bucket.
2. **Fold noProgress\* into goalState** so `__resetGoalState()` is the
   single reset seam (extend its test).
3. **Overlay/status**: the composite widget reads the parent bucket only
   (renderSid pattern); a child's goal activity never paints the parent's
   overlay.
4. **Seam note**: `__piGoalActive` publishes from the PARENT session's
   state (extensions/task.ts registration context) — keep it parent-only;
   a child's goal activity must not flip the seam (test).
5. Tests: two interleaved faux sessions (parent + child) driving goals
   independently — continuations, timers, overlay reads, and the seam all
   parent-scoped; reset-seam completeness.

Not in scope: todo (done); loop (ticket 03 owns its disposition); the
auditor's empty-ResourceLoader isolation (already correct).

## Done-when

- [ ] Parent goal continues normally while a child session runs a goal
      (faux-transport interleaved test green; no cross-fires).
- [ ] `__resetGoalState()` resets every session-scoped counter
      (noProgress included, test-pinned).
- [ ] Canonical gates green; ext-task #16 closed in the same PR; PR
      merged CLEAN.
