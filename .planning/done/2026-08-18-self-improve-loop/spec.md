# Spec: self-improve-loop

## Context
Round 2 (#1682) proved one-shot cleanups decay: a duplicate skill was born the
same day de-duplication landed, the schema-cost canary regressed to zero rows
unnoticed, and soak verification (#1681) is a human-memory task. D2-D4 (grill)
settle the shape: thin root shim + loop subcommand, REPORT-ONLY autonomy,
merge the duplicate skill.

## Goals
- G1 ./pi-agent.sh exists at repo root: plain sh shim (~10 lines), exec bun
  bun-apps/pi-agent/src/cli.ts "$@", chmod +x. No logic.
- G2 `pi-agent.sh loop status` prints a drift report, exit 0 always:
  death rate (spawn runs-stats.ts; broad % + dispatch count vs #1681 bar 15%),
  skill line counts (superpowers + wayfind vs 300 bar), duplicate scan
  (dispatch-budget-rebalance references; post-merge must be 0 in skills/),
  canary rows (schema-cost output rows for wayfind/superpowers; 0 rows = DRIFT),
  wayfind coverage floor (min line % across src from bun test --coverage).
- G3 One dispatch skill: dispatch-budget-rebalance merged into
  dispatch-recovery (calibration procedure = a section); 16 -> 15 skills;
  all 6 blast-radius files updated.
- G4 Docs truth: superpowers README skill count, CLAUDE.md gains ./pi-agent.sh
  mention, #1681 comment points at the loop command as its verification tool.

## Non-goals
- Autonomous fixing (report-only, D3); remote CI; webui/gui; new deps.

## Build surface
- M1 shim: ./pi-agent.sh (sh, exec, pass-through "$@").
- M2 loop: bun-apps/pi-agent/src/cli/commands/loop.ts + registry wiring;
  plain Bun (Bun.spawn / Bun.file), spawn subpackage scripts, parse, print
  PASS/DRIFT table. Tests: loop.test.ts with fixture parsers (no live spawns
  in unit tests; parsing functions exported pure).
- M3 merge: append calibration section to dispatch-recovery/SKILL.md (from the
  44-line source, compressed), delete dispatch-budget-rebalance/ dir, update
  skills.test.ts + UPSTREAM.ref (rebaseline flow), subagent README/ADR-0005/
  runs-stats comment -> point at superpowers:dispatch-recovery.
- M4 docs+close: README count 15, CLAUDE.md one line under Active stack or
  Repo mechanics, #1681 comment, done ceremony.

## Risks
- Registry wiring differs per command type -> follow an existing commands/
  file's exact pattern (doctor.ts or schema-cost.ts) before adding loop.ts.
- Skill merge breaks skills.test.ts expectations -> run rebaseline flow first,
  then bun test.

## Verification
- ./pi-agent.sh doctor (or --help) runs end-to-end via the shim.
- ./pi-agent.sh loop status prints all 5 rows, exit 0.
- superpowers bun test green (15 skills), subagent bun run test green.
