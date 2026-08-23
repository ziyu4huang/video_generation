# Ticket 07 — batch-agent-type

status: closed 2026-08-23 (PR #1845 → main f0e82bc7)

## Goal

Per-task `agentType` on the `list_subagents` batch tool, resolved exactly as the
singular path does.

## Steps

1. `s2-agent-ext-subagent/src/subagents-tool.ts` — per-task schema gains `agentType`;
   resolve via `resolveAgentType` (`agent-registry.ts:153`) mirroring
   `subagent-tool.ts:138-149`, including unknown-type failEarly listing per task.
   ~~(only that task fails)~~ — amended at implementation: the WHOLE batch is
   rejected pre-dispatch, with per-task `[index]` errors + the available-types
   hint (see Decision below).
2. Read-only exclusion stays non-overridable: agentType tool bindings intersect with
   the read-only set; explicit `tools` in the task still wins (singular-path parity).
3. Worktree-isolating agentTypes are REJECTED in batch with a clear message (batch
   loop does not allocate per-child worktrees).

## Decision (implementation)

Unknown agentType rejects the whole batch BEFORE dispatch (the newer next-goal's
semantics) rather than failing only that task (this ticket's original wording):
a positional `null` slot cannot carry the "Available agentTypes" hint the caller
needs to fix the call, and whole-batch rejection is atomic — no partial spend on
good tasks before a bad one is discovered. The per-task `[index]` listing keeps the
original wording's findability. Reviewer judged the reconciliation sound.

## Tests

- Extend batch tool tests — resolution, unknown type rejects the batch pre-dispatch,
  read-only intersection (merge level + requiredTools preflight), worktree-isolating
  rejection, precedence pins (explicit task fields > definition), tier-default fold.

## Acceptance

Subagent `bun run test` green (667 pass / 0 fail); no batch read-only regression
(`READ_ONLY_EXCLUDED` untouched, non-overridable even via a definition allowlist).
Reviewer APPROVE, 5 non-blocking findings — 2 fixed pre-merge (persistence tier
fold `task.tier ?? agentDef.tier`; 3 added test pins), 2 recorded on map.md as
parity-ledger fog (pre-existing capability/tier display-order divergence between
the two tools; empty-string agentType falsiness, parity with the singular path),
1 = this amendment.
