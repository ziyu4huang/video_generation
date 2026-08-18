---
effort: 2026-08-18-self-improve-loop
created: 2026-08-18
last: 2026-08-18
status: done
---

# Wayfinder map: self-improve-loop

## Destination
A compact, duplicate-free, continuously-measured self-improvement loop over the
solution extensions (wayfind + superpowers + subagent), driven by a plain-Bun
root entrypoint ./pi-agent.sh: measure drift -> charter/execute small fixes ->
re-measure, with no duplicated guidance surfaces and a streamlined bun-native
dev cycle.

## Notes (self-reflection evidence, 2026-08-18)
- Round 2 (#1682) landed: skills -708 lines all <=300, sizing rule single
  source, SUBAGENT_MAX_TURNS valve, wayfind coverage script; soak #1681 tracks
  <15% broad death rate over next ~100 dispatches.
- Dispatch record this session: ~25 dispatches, >=8 turn-capped deaths until
  sizing discipline landed mid-turn; ZERO deaths on the last 6 (verbatim-apply
  + sized turns). Enforcement gap, not rules gap.
- DUPLICATE BORN SAME DAY: superpowers:dispatch-budget-rebalance (landed via
  parallel budget work) overlaps dispatch-recovery's new sizing section — 16
  skills now. De-duplication decays without a drift detector.
- Schema-cost canary regressed to zero rows unnoticed (round1 557-token figure
  gone by round2). Nothing re-checks the checkers.
- Round-2's 10,585 LOC target was a find|xargs artifact; real baseline 4,210
  LOC, 0 dead code. Measure correctly (coverage-gated) before cutting.
- Soak verification (#1681) is currently a human-memory task.
- Existing surface: bun-apps/pi-agent/src/cli.ts wrapper (CLAUDE.md prefers
  it); CLAUDE.md documents pi-agent entrypoints. pi-agent.sh does not exist.

## Decisions so far
- D1 Loop = measure -> detect drift -> small gated fixes -> re-measure. Plain
  Bun runtime, no new deps (bun:test, bun --coverage, gh CLI, git).
- D2 (grill 2026-08-18) pi-agent.sh = thin root sh shim (~10 lines) exec-ing
  bun bun-apps/pi-agent/src/cli.ts; the loop itself is a NEW loop subcommand
  inside pi-agent's cli — one code path, no duplicate entrypoints.
- D3 (grill) Loop autonomy = REPORT-ONLY: loop status prints a drift report
  (death rate vs #1681 bar, skill line counts vs 300 bar, duplicate-symbol
  scan, schema-cost canary rows, coverage floor); every fix stays a gated
  human/agent action (#1616 lesson encoded: no autonomous long-running loop).
- D4 (grill) Merge dispatch-budget-rebalance INTO dispatch-recovery — one
  skill owns dispatch-time rules + calibration procedure; 16 -> 15 skills.

## Not yet specified
- None — grill settled 2026-08-18; spec next.

## Out of scope
- Re-enabling remote CI; goal-mode autonomous long-running agents (#1616
  lesson: blocked-on-human loops must stay user-stopppable).
- webui/gui packages.


## Addendum 2026-08-19 — executed (all tickets done)
| Goal | Result |
|---|---|
| G1 ./pi-agent.sh | Pre-existing surface (symlink -> 238-line run.sh launcher); honest close; launcher restored after child overwrite |
| G2 loop status | commands/loop.ts wired into COMMANDS (bun bun-apps/pi-agent/src/cli.ts cli loop status); 5 signals; parsers 8/0; report-only exit 0 |
| G3 skill merge | dispatch-budget-rebalance -> dispatch-recovery Calibration (7732e1ec1); 16->15 skills; suite 140/0 |
| G4 docs/soak | README verified truthful; CLAUDE.md loop surface (9e5d7600a); #1681 verification scripted |

Commits: b51522614/586686992 (01), a0b7997e1 (02), 7732e1ec1 (03), 9e5d7600a (04p1) + this close commit.
