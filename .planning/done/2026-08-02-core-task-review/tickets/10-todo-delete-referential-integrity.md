---
type: task
status: closed
blocked by:
findings: M5, L9
resolved: 2026-08-12 — shipped in #1064 — delete prunes `blockedBy` + referential-integrity check
---

# 10 — Todo delete referential integrity (prune `blockedBy` + scope `invariants.ts`)

## Problem

Deleting a task only flips its status — it never prunes the deleted id from other tasks' `blockedBy`. The overlay still renders `⛓ #B` for a task depending on a now-deleted `B`; `get` reports a tombstone id; `deriveBlocks` still maps it. The agent gets no signal that a dependency disappeared. (`invariants.ts` (L9) also only enforces status transitions — referential integrity is all inline.)

## Evidence

- `core-task/src/todo/state/state-reducer.ts:151-164` — `delete` flips status only; no cleanup.
- Adding a deleted dep is forbidden (`:41,97`) but existing ones aren't pruned.
- Rendered stale: `view/format.ts:85` (`⛓ #B`), `tool/response-envelope.ts:8-13` (tombstone id in `get`).
- `state/invariants.ts:8-24` — only `VALID_TRANSITIONS` + `isTransitionValid`.

## Approach

1. On `delete`, sweep all tasks and filter the deleted id from every `blockedBy` (a `removeBlockedBy`-style prune). Decide UX: silent prune, or also surface a warning listing the dependents (recommend the warning — the agent asked for the dependency implicitly).
2. Centralize the rule as `validateReferentialIntegrity` in `invariants.ts` (begin scoping that file beyond transitions — L9).
3. Test: create A blockedBy B, delete B, assert A's `blockedBy` no longer contains B and the overlay no longer renders `⛓ #B`.

## Acceptance

- [ ] Delete prunes dangling `blockedBy` references (test).
- [ ] Dependent-warning surfaced (or an explicit decision to prune silently, documented).
- [ ] `invariants.ts` gains the referential-integrity rule.
