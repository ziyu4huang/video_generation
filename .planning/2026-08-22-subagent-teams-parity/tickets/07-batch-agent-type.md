# Ticket 07 — batch-agent-type

status: open

## Goal

Per-task `agentType` on the `list_subagents` batch tool, resolved exactly as the
singular path does.

## Steps

1. `s2-agent-ext-subagent/src/subagents-tool.ts` — per-task schema gains `agentType`;
   resolve via `resolveAgentType` (`agent-registry.ts:153`) mirroring
   `subagent-tool.ts:138-149`, including unknown-type failEarly listing per task
   (only that task fails).
2. Read-only exclusion stays non-overridable: agentType tool bindings intersect with
   the read-only set; explicit `tools` in the task still wins (singular-path parity).
3. Worktree-isolating agentTypes are REJECTED in batch with a clear message (batch
   loop does not allocate per-child worktrees).

## Tests

- Extend batch tool tests — resolution, unknown type fails only that task, read-only
  intersection, worktree-isolating rejection.

## Acceptance

Subagent `bun run test` green; no batch read-only regression
(`READ_ONLY_EXCLUDED` untouched).
