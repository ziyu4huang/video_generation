---
effort: 2026-08-18-ext-simplification-round-2
created: 2026-08-18
last: 2026-08-18
status: active
---

# Wayfinder map: ext-simplification-round-2

## Destination
Second data-driven simplification pass over the solution extensions (wayfind +
superpowers), grounded in fresh dispatch running history: cut measured waste
(prompt weight, dead code) and cut the measured dispatch death rate, without
losing behavior (both suites green) or the codified pipeline's guarantees.

## Notes
- Round 1 (2026-08-16 plan, 14 tasks, PR #1574) cut schema cost (wayfind_effort
  557 tokens) and consolidated skills; baselines then: wayfind 513/0, superpowers
  138/0.
- Fresh census 2026-08-18 (runs-stats.ts, 200 runs): done 126 (63%), turns-capped
  63 (31.5%, median 84k tok / 5 turns), budget 11 (5.5%, median 154k). Broad
  death rate 37% = 2.2x the 17% baseline census (PR #1626). Dominant mode:
  turn-limit termination.
- Shapes: wayfind 10,585 TS LOC (lower bound) vs 953 skill-doc lines; 513 tests
  [796ms]; 9 commits since 08-16. superpowers 1,603 TS LOC vs 3,510 SKILL.md
  lines (writing-skills 715, subagent-driven-development 503); 144 tests
  [161ms]; 8 commits since 08-16.
- REGRESSION (noted, out of scope): schema-cost.ts returns zero rows for both
  packages — Task-12 canary coverage (wayfind_effort 557 tokens) is gone.
- Recon anchors 2026-08-18: pi-agent-ext-subagent budget-defaults.ts already
  tiers token ceilings (small 500k / medium 1.2M / big 1.5M, p90-calibrated);
  NO maxTurns default exists anywhere — turns-caps are per-dispatch authoring
  choices. dispatch-recovery skill is a compact 49-line recipe (trust rules,
  janitor-first, verbatim-apply, ledger). Wayfind has no coverage script; 5 of
  its skills mention subagent/dispatch (ask-matt, grilling,
  improve-codebase-architecture, to-spec, to-tickets).
- Constraints: superpowers SKILL.md edits follow ADR-superpowers-0004 fidelity
  (edit -> rebaseline-upstream-skills.ts -> bun test; LOCAL-DIVERGENCES rows in
  UPSTREAM.ref). Dispatch empirics live in superpowers:dispatch-recovery skill.

## Decisions so far
- D1 Round 2 is chartered from fresh running-history data, not round-1 residue.
- D2 Levers: dispatch survival + skill slimming + wayfind code prune. Schema-cost
  canary restore explicitly OUT (regression stays noted, not fixed here).
- D3 Success bar (both): skills <=300 lines/file; wayfind -20% TS LOC where
  safe; death rate <15% over next 100 dispatches deferred to soak issue (D7).
- D4 Process: full wayfind cycle (map -> grill -> spec -> tickets -> execute ->
  done).
- D5 Survival mechanism (all three): skills discipline in superpowers
  (budget-before-dispatch sizing, verbatim-apply default, turn-1 mega-block);
  wayfind dispatch pointer blocks (point to superpowers:dispatch-recovery as
  single source — no duplicated recipe); raise subagent defaults = ADD a
  maxTurns default (user explicitly OK'd touching pi-agent-ext-subagent; token
  ceilings stay as-is).
- D6 Wayfind prune method: coverage-guided (add coverage script; ~0%-coverage +
  non-entry modules = candidates; no live-code cuts to hit the number).
- D7 Done gate: close on line targets + suites green + point-in-time re-census;
  100-dispatch <15% bar becomes a tracked soak follow-up issue (#1645 pattern).

## Not yet specified
- None — grill settled 2026-08-18; see spec.md.

## Out of scope
- webui / gui / non-solution-extension packages (except the D5 maxTurns default
  in pi-agent-ext-subagent, explicitly authorized).
- Re-architecting the subagent tool core; token-budget recalibration.
- Schema-cost canary re-registration.
