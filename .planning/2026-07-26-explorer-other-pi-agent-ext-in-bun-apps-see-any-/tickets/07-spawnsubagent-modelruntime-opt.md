---
type: task
status: open
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

## blocked by

(none — independent of 04)

## Note

This is an auth/context-sharing shortcut, not a hardcode: the parent runtime was
itself config-resolved; the opt reuses it. Consistent with the no-hardcode
principle.
