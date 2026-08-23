---
type: code
blocking: [01]
status: done
---

# 02 loop status subcommand (spec M2, G2)

## Question
Can one report-only command make all five drift signals visible in one shot?

## What to build
- bun-apps/pi-agent/src/cli/commands/loop.ts following the existing commands/
  pattern (copy doctor.ts or schema-cost.ts structure exactly — registry,
  arg parsing, output style).
- Rows (PASS/DRIFT + value vs bar): death rate (Bun.spawn bun
  bun-apps/pi-agent-ext-subagent/scripts/runs-stats.ts, parse totals; broad %
  = (turns+budget)/total vs 15% bar + dispatch count); skill lines (scan
  superpowers + wayfind skills/*/SKILL.md, max vs 300); duplicate scan (grep
  dispatch-budget-rebalance under skills/ -> 0 after merge); canary rows
  (spawn schema-cost command or import its core, count wayfind/superpowers
  rows; 0 = DRIFT); coverage floor (spawn bun test --coverage in wayfind,
  min line % across src/).
- Pure exported parser functions (parseRunsStats, maxSkillLines, etc.);
  loop.test.ts unit-tests parsers against fixture strings (no live spawns).
- Exit 0 always (report-only). Live spawns cached per invocation, sequential.

## Acceptance
- bun bun-apps/pi-agent/src/cli.ts loop status prints all 5 rows, exit 0.
- ( cd bun-apps/pi-agent && bun test ) green incl. new loop.test.ts.

## Completion 2026-08-18
Parser keyword-first+anchored (cohort-row guard); wired into COMMANDS (dispatch: bun bun-apps/pi-agent/src/cli.ts cli loop status); parsers unit-tested 8/0; report-only exit 0; fixed comment inner-*/ syntax error. Full-suite bar at pre-push 20-gate hook.
