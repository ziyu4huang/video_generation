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
- REGRESSION: schema-cost.ts now returns zero rows for both packages — the
  Task-12 canary coverage (wayfind_effort 557 tokens) is gone; prompt-token cost
  of both packages is currently unmeasured.
- Constraints: superpowers SKILL.md edits follow ADR-superpowers-0004 fidelity
  (edit -> rebaseline-upstream-skills.ts -> bun test; LOCAL-DIVERGENCES rows in
  UPSTREAM.ref). Dispatch empirics live in superpowers:dispatch-recovery skill.

## Decisions so far
- D1 Round 2 is chartered from fresh running-history data, not round-1 residue.

## Not yet specified
- Q1 Primary levers (grill): dispatch survival vs skill slimming vs wayfind code
  prune vs schema-cost canary restore (multi-select).
- Q2 Success bar: death-rate target, line targets, or both.
- Q3 Process depth: full wayfind cycle vs tickets-only.

## Out of scope
- webui / gui / non-solution-extension packages.
- Re-architecting the subagent tool core (budget/turn mechanics tuned only via
  config/skills) — unless grill says otherwise.
