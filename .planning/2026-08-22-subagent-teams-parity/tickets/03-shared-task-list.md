# Ticket 03 — shared-task-list

status: open

## Goal

`task_create` / `task_get` / `task_list` / `task_update` with CC semantics, shared by
parent, spawn children, and workflow agents.

## Steps

1. NEW `core-runtime/src/team-task-store.ts` — process-singleton `TeamTaskStore`
   keyed by parent sessionId; in-memory only; fields + cycle check per spec §2.
2. NEW `s2-agent-ext-subagent/src/task-tools.ts` — the four ToolDefinitions, thin
   adapters over the store.
3. `extensions/subagent.ts` — register the four tools; add to the batch read-only-safe
   set. Children/workflow agents receive them via the existing `extensionTools`
   bridges — zero dispatch-path changes.
4. CONTEXT.md term `team task list` with `_Avoid_:` todo (ext-task session
   scratchpad), goal, ticket (wayfind); cross-ref ext-task CONTEXT.

No registry.yaml change, no new ext (map D9).

## Tests

- NEW core-runtime `src/team-task-store.test.ts` — CRUD, dependency edges, cycle
  rejection, per-session isolation, session reset.
- NEW subagent `tests/task-tools.test.ts` — schema validation, owner claim, read-only
  child availability, extensionTools propagation to a fake child toolset.

## Acceptance

core-runtime + subagent `bun run test` green; cross-package typecheck green.
