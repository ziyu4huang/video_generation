---
type: task
status: closed
---

# 07 — spawnSubagent `modelRuntime` opt

## Question

Add an optional `modelRuntime` to `SpawnSubagentOptions`: when set, the spawned
subagent reuses the caller-provided (parent's) authenticated runtime instead of
re-resolving from config. Small, broadly-useful extension (auth/context sharing).
Unblocks core-task (08).

## What resolving it looks like

- `SpawnSubagentOptions.modelRuntime?: ModelRuntime` — when present, passed to
  `createAgentSession` as `modelRuntime` (the exact path core-task's auditor
  already uses at `auditor.ts:165`);
- when absent, current behavior (resolve from config);
- + test: caller-provided runtime is used (not re-resolved).

## Resolution (closed)

Implemented. `SpawnSubagentOptions.modelRuntime?: CreateAgentSessionOptions["modelRuntime"]`
— a top-level shortcut for the auth/context-sharing seam. Forwards via a pure
`resolveSessionOverride(session, modelRuntime)` helper (exported, mock-free
unit-tested) that merges the runtime into the WorkflowAgent constructor's
`session` override, winning on conflict with `session.modelRuntime`.

Note: `session?: Partial<CreateAgentSessionOptions>` already covered this
(added during file2md Phase 2); the dedicated opt is ergonomics/discoverability
for core-task (08), which can now `spawnSubagent({ modelRuntime: parentRuntime })`.
Not a hardcode — the parent runtime was itself config-resolved. Unblocks 08.

3 tests (merge contract: passthrough / merge / win-on-conflict). subagent 298/0.

## blocked by

(none — independent of 04)

## Note

This is an auth/context-sharing shortcut, not a hardcode: the parent runtime was
itself config-resolved; the opt reuses it. Consistent with the no-hardcode
principle.
