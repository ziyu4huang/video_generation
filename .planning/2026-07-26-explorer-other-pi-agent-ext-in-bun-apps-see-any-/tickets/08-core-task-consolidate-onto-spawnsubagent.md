---
type: task
status: open
blocked by: 07
---

# 08 — core-task → spawnSubagent

## Question

Consolidate core-task's `goal/auditor.ts` from direct `createAgentSession` onto
`spawnSubagent`, using the new `modelRuntime` opt (07) to pass the parent's
runtime. Gains §3 (retry/timeout) + §4 (telemetry visibility to `/subagents`).

## What resolving it looks like

- the auditor's `sessionFactory`/`createAgentSession` call becomes a
  `spawnSubagent({ modelRuntime: ctx.modelRegistry.runtime, ... })`;
- the parent-runtime reuse is preserved via the opt;
- goal auditing still works + now inherits retry/timeout + telemetry.

## blocked by

07 (modelRuntime opt)
