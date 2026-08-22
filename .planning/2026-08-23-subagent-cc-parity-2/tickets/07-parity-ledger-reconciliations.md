# Ticket 07 — parity-ledger reconciliations + spec sign-off

Status: open · Phase 4 (last — needs tickets 02–06 rows landed)

## Scope

Close the two fog divergences carried from teams-parity ticket 07 and finalize
the parity ledger:

1. **Display-model precedence unification.** Today the batch tool
   (`list_subagents`) resolves display model as model > tier > capability >
   mainModel while the singular `resolveDisplayModel` is model > capability >
   tier > mainModel — the same task shows a different display string on the
   two tools. Pick ONE order (the singular's, as the more recent semantic) and
   make both paths share a single resolve function.
2. **`agentType` minLength guard.** Empty-string `agentType: ""` is falsy →
   silently "no type" on BOTH paths. The prior reason for skipping the guard
   (it would diverge the two paths) evaporates when both get it in one PR.
3. **spec.md final pass**: every ticket's §2/§3 rows confirmed updated,
   divergence table signed off, CC citations re-checked.

Start by locating both display-model call sites precisely (the ticket body
should record them once measured).

## Files

- `bun-apps/s2-agent-ext-subagent/src/subagents-tool.ts` + the shared
  resolver's home (singular path / core-runtime)
- Both tool schemas (`subagent-tool-schema.ts`, `subagents-tool.ts` schema)
- `.planning/2026-08-23-subagent-cc-parity-2/spec.md`

## Risks

- The precedence change alters persisted display strings — check
  run-persistence consumers and pin tests.

## Verification

- A shared-precedence unit test asserting batch and singular produce
  IDENTICAL display strings for the same inputs across the
  capability × tier matrix.
- Schema guard tests for `agentType: ""` on both tools.
- Full gates in s2-agent-ext-subagent (+ ultracode if the resolver moves into
  core-runtime).
