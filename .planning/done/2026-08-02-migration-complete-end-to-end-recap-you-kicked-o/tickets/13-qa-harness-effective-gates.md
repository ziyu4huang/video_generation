## Question

`qa/evaluate.ts` still consumes only the hardcoded `GATES` (FOLLOWUPS #2). Upgrade it to consume `buildEffectiveGates()` from owner-declared defs, then restore the 8 data-driven inspect precision/escape probes dropped in migration Task 3 (4 already recovered as unit tests). Restores the QA coverage lost during migration. Must land before the hardcoded GATES can be deleted (else evaluate.ts breaks).

type: task
blocked by:

## Note (from ticket 03)

A STOPGAP reconstruction (`reconstructOwnerDeclaredGates` in `qa/evaluate.ts`) was added in ticket 03 so the corpus stays live while tools migrate out of hardcoded GATES — it groups same-signature owner-declared tools into one multi-name gate. This is an APPROXIMATION (re-merged), not the literal effective gate set. Ticket 13 still must: (a) swap it for `buildEffectiveGates` so the corpus validates the literal effective (single-name) gates; (b) handle the coverage-model fallout (a migrated sibling becomes a standalone `names[0]` gate needing a probe or coverage-logic update — the stopgap's merge currently papers over this); (c) restore the 8 dropped inspect precision/escape probes (orthogonal; `probes.ts` has zero inspect entries today).

## Progress — part (a)+(b) done

- (a) evaluate.ts now consumes buildEffectiveGates() (single-name effective gates) instead of the reconstructOwnerDeclaredGates stopgap (DELETED). buildEffectiveGates is pure production code; CORPUS_EFF + CORPUS_GATES (=CORPUS_EFF.gates) exported. Per-tool firing semantics unchanged (identical name multiset); only the gate-set shape changed (collapsed multi-name → single-name).
- (b) coverage-gap logic adapted to single-name gates via signature-grouping (group by {keywords,requires}; a group is covered iff ≥1 must-fire + ≥1 must-not-fire across siblings). `bun run qa` default verdict PASS. coverage.ts analyzer rewired off legacy module TRACKED_TOOLS → CORPUS_EFF.tracked (param default; pure unit fixtures unaffected). Eliminated 9 migrated-tool false-positives (gated-heavy 11→20).
- Numbers: l2/savings UNCHANGED (identical name multiset); miss-rate cosmetic only.
- Tests: bun test 263/0; `bun run qa` default PASS.
- Commit: d9bee58c.

## Remaining — part (c) inspect probes (13b)

- 8 inspect probes still to restore (qa/probes.ts has zero inspect entries today). Prerequisites MET (verified): all 6 inspect_* tools already carry owner-declared gating; power-tool registrar (extensions/power-tool.ts) exists → 13b is a SMALL "add registrar + author probes" (no power-tool rollout). Adding the registrar creates new un-probed inspect signature-groups, so the probes (≥1 must-fire + ≥1 must-not-fire per distinct inspect signature-group) must be authored in the same change.

## New finding (surfaced by 13a's correct coverage measurement)

- `bun run qa --strict` now reports 6 genuinely-ungated heavy tools (was 15 at HEAD; 13a eliminated 9 false-positives — verified via git stash). Of the 6: inspect_pathology → fixed by 13b (power-tool registrar); 5 tools have NO gating and need gating/always-on DECISIONS (out of 13a + 13b scope): subagents, sweep_branches, await_pr_merge, memory_supersede, wayfind_effort. So qa --strict coverage FAILS until 13b + those 5 decisions land (pre-existing after ticket 12; 13a improves 15→6, does not regress).

status: closed

## Resolution — part (c) done; ticket 13 CLOSED

13b completed the final part: the power-tool registrar (`@repo/pi-agent-ext-power-tool/extensions/power-tool.ts`) was added to qa/evaluate.ts captureOwnerDeclaredDefs → captures all 6 inspect_* tools (inspect_context, inspect_agent, inspect_extensions, inspect_hooks, inspect_pathology, inspect_tui), which share ONE identical signature-group (keywords: schema cost/pathology/extension health/工具開銷/context window/token usage; requires nouns+verbs; canonical names[0]=inspect_context). 8 inspect probes restored in qa/probes.ts: 4 must-fire (incl. a requires-only noun∧verb case), 2 must-not-fire (incl. the famous "inspect element"/"inspect dom tree" false-fire the requires fix killed), 1 escape-name, 1 escape-intent. Capture stub tolerated power-tool's factory unchanged. Tests: bun test 271/0 (+8 new probe tests), `bun run qa` default PASS (coverageGaps []), `bun run qa --strict` ungated 6→5 (inspect_pathology now captured+gated). Commit: ba651995.
Ticket 13 COMPLETE: (a) buildEffectiveGates swap [13a], (b) coverage fallout fix [13a], (c) inspect probes [13b].
STILL OPEN (separate scope, NOT ticket 13): `bun run qa --strict` coverage still fails on 5 genuinely-ungated heavy tools needing gate-vs-always-on decisions: subagents, sweep_branches, await_pr_merge, memory_supersede, wayfind_effort.
