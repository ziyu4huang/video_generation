---
type: skill-docs
blocking: none
status: open
---

# 03 Merge dispatch-budget-rebalance into dispatch-recovery (spec M3, G3)

## Question
One skill owning dispatch-time rules + calibration — 16 -> 15?

## What to build
- Append a "Calibration (rebalance) procedure" section to dispatch-recovery/
  SKILL.md: compressed content of the 44-line source (runs-stats medians ->
  bounds; never intuition), stays <=300 total.
- Delete skills/dispatch-budget-rebalance/ directory.
- Update blast radius: tests/skills.test.ts + UPSTREAM.ref via bun
  scripts/rebaseline-upstream-skills.ts; pi-agent-ext-subagent README,
  docs/adr/0005, scripts/runs-stats.ts comment -> superpowers:dispatch-recovery.

## Acceptance
- skills/ has 15 dirs; dispatch-recovery SKILL.md contains the calibration
  section; grep dispatch-budget-rebalance bun-apps/ --include='*.md' -> only
  historical ADR/changelog mentions (no live skill references).
- superpowers bun test green.
