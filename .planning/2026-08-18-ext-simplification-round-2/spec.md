# Spec: ext-simplification-round-2

## Context
Round 1 (PR #1574) simplified the solution extensions structurally. Since then,
running history degraded: broad dispatch death rate 17% -> 37% (2.2x), dominant
mode = turn-limit termination (31.5% of 200 runs, median 84k tok / 5 turns).
Superpowers now carries 3,510 SKILL.md lines vs 1,603 code lines; wayfind the
inverse (10,585 TS LOC vs 953 doc). This effort cuts measured waste and the
death rate with behavior-preserving changes under green-test safety nets.

## Goals (measurable)
- G1 Superpowers skills: every SKILL.md <=300 lines (writing-skills 715,
  subagent-driven-development 503, systematic-debugging 333,
  test-driven-development 320 -> all <=300; ~-671 lines).
- G2 Wayfind: -20% TS LOC (10,585 -> <=8,470) via coverage-guided dead-path
  prune; 513 tests stay green.
- G3 Dispatch survival: skills-side discipline (sizing, verbatim-apply,
  turn-1 mega-block) + a package maxTurns default; point-in-time re-census at
  close; <15% over next 100 dispatches tracked via soak issue.

## Non-goals
- Subagent token-budget recalibration (ceilings already p90-tiered).
- Schema-cost canary re-registration (regression noted in map; separate work).
- webui/gui or any non-solution-extension package (except the authorized
  maxTurns default in pi-agent-ext-subagent).

## Build surface

### M1 Superpowers skill slimming + discipline injection
- Compress the 4 over-bar SKILL.md files to <=300 lines each, content-preserving
  in intent (rules kept, prose tightened, examples merged).
- Fidelity flow per ADR-superpowers-0004: edit -> bun
  scripts/rebaseline-upstream-skills.ts -> bun test; LOCAL-DIVERGENCES rows in
  tests/__fixtures__/upstream-skills/UPSTREAM.ref.
- Inject dispatch discipline ONCE (single source): dispatch-recovery (49 lines,
  stays <=300) gains the budget-before-dispatch sizing rule (turns >= task
  steps + 2; tokens by tier; verbatim-apply as default authoring mode; turn-1
  mega-block). SDD + executing-plans REFERENCE it, not duplicate.
- Acceptance: wc -l all skills/*/SKILL.md max <=300; superpowers bun test green
  (144+); rebaseline flow ran clean.

### M2 Subagent maxTurns default (pi-agent-ext-subagent, authorized)
- budget-defaults.ts (or sibling): DEFAULT_MAX_TURNS = 12 + env override
  SUBAGENT_MAX_TURNS, applied only when caller omits maxTurns; explicit caller
  values unchanged.
- Tests: default applied when omitted; env override; explicit value untouched.
- Acceptance: ( cd bun-apps/pi-agent-ext-subagent && bun run test && bun run
  typecheck ) green.

### M3 Wayfind dispatch pointer blocks
- The 5 skills mentioning subagent/dispatch (ask-matt, grilling,
  improve-codebase-architecture, to-spec, to-tickets) each carry a <=10-line
  block pointing to superpowers:dispatch-recovery + the sizing one-liner. No
  duplicated recipe.
- Acceptance: wayfind bun test green (513+); grep shows pointer present in all
  5; no full-recipe duplication (dispatch-recovery remains the only full text).

### M4 Wayfind coverage-guided prune
- Add "coverage" script (bun test --coverage) to package.json.
- Census modules: ~0% coverage AND not reachable from the extension entry =
  prune candidates; record the census table in the ticket/report.
- Prune to <=8,470 TS LOC; if honest dead-path yield < 20%, take what is real
  and document the shortfall — no live-code cuts to hit the number.
- Acceptance: wayfind bun test green (513+); tsc/typecheck clean; LOC target or
  documented shortfall.

### M5 Close-out
- Point-in-time re-census (runs-stats.ts) recorded in map Notes / done folder.
- Soak issue filed: "<15% broad death rate over next 100 dispatches" (mirror
  #1645 warn-only->blocking pattern).
- Done ceremony per codified pipeline (completeEffort, done/ folder).

## Risks
- Rebaseline drift on skill edits -> follow ADR-superpowers-0004 exactly; tests
  enforce.
- Prune false-dead (dynamically imported / string-referenced modules) ->
  entry-reachability grep per candidate before deletion; tests + tsc as net.
- maxTurns default lengthening runaway children -> token ceilings unchanged
  (hard abort 500k+); default only affects unspecified dispatches.

## Verification
- Per-package gates: superpowers bun test; wayfind bun test (+typecheck);
  subagent bun run test (check+build+unit) + typecheck.
- Line-count proofs (wc -l) captured in each ticket's completion report.
- Final: local_ci full matrix optional (docs+code mix) — package gates
  sufficient per milestone.
