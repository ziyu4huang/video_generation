# Ticket 07 — parity-ledger reconciliations + spec sign-off

Status: done (2026-08-23) · Phase 4 (last — needs tickets 02–06 rows landed)

## Measured call sites (2026-08-23, this tree)

- Singular resolver: `src/subagent-tool-run.ts` `resolveDisplayModel`
  (model > capability > tier > mainModel, prefixed display strings).
- Batch display chain (pre-07): `src/subagents-tool.ts` `runTask`'s `childModel`
  — `task.model ?? agentDef?.model ?? task.tier ?? agentDef?.tier ??
  task.capability ?? mainModel ?? "default"` (tier above capability, RAW
  values, no prefixes).
- THIRD site found during implementation: the singular background track record
  (`src/subagent-tool.ts`, `manager.track({...})`) collapsed to
  `params.model ?? agentDef?.model ?? "default"` — dropped tier AND capability
  entirely; unified in the same PR.

## Landed

1. Batch `childModel` + the background track record both route through the
   shared `resolveDisplayModel` (definition model/tier fold below task fields,
   matching the singular's in-flight string). Observable change: batch slots
   render `tier:big`/`capability:vision` instead of raw values, capability
   beats tier where both are set; the background notification embeds the full
   precedence instead of "default".
2. `agentType` guards on both tools: schema `minLength: 1` + runtime
   `!== undefined` (singular failEarly `Unknown agentType ""`; batch
   whole-batch reject `[i] unknown agentType ""` before any dispatch — the
   registry-load gate switched off truthiness too so the error lists the
   available types instead of "no definitions found").
3. spec.md §2 model-override row updated + §8 sign-off section added
   (all tickets' rows confirmed, §3 reviewed, §6 citations re-checked).

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
