# Ticket 01 — Exhaustive `persistedToSnapshot` adapter in `run-persistence.ts`

> Wave 1 · spec §2.1 · status: open

## Goal

Move the hand-maintained `PersistedRunState → WorkflowSnapshot` constructor (today private in
`workflow-ui.ts:193–224`) into `run-persistence.ts` as an exported, **compile-time-exhaustive**
adapter: every key of `PersistedAgentState` (`run-persistence.ts:13–30`) must have a projection
row (`satisfies Record<keyof PersistedAgentState, …>` or equivalent). An unmapped new persisted
field becomes a compile error — the PR-#1362 bug class (new field, blank resumed row) is made
structurally impossible.

## Acceptance criteria

- `persistedToSnapshot` exported from `run-persistence.ts`; `workflow-ui.ts` imports it and its
  local copy is deleted.
- Exhaustiveness check compiles: removing a projection row (or adding a `PersistedAgentState`
  field without one) fails the package typecheck.
- Regression test: round-trip a fully-populated `PersistedAgentState` and assert every snapshot
  field maps; **legacy-omit** case (persisted JSON without `tokens`/`model`) degrades gracefully.
- Rendered navigator output byte-identical to pre-move (existing tests green).
- Gate: `( cd bun-apps/pi-agent-ext-workflow && bun run test )`.

## Files

- `bun-apps/pi-agent-ext-workflow/src/run-persistence.ts` (adapter + exhaustiveness check)
- `bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts` (delete local copy, import adapter)
- `bun-apps/pi-agent-ext-workflow/tests/` (round-trip + legacy-omit regression)
