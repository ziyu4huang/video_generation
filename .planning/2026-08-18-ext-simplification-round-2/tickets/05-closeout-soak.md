---
type: docs+process
blocking: [01, 02, 03, 04]
status: open
---

# 05 Close-out: re-census + soak issue + done ceremony (spec M5)

## Question
Did round 2 move the measured numbers, and is the 100-dispatch bar tracked?

## What to build
- Point-in-time re-census: bun bun-apps/pi-agent-ext-subagent/scripts/runs-stats.ts
  recorded into the effort map Notes (or done folder).
- File soak issue: "<15% broad death rate over next 100 dispatches — flip
  tracked" mirroring #1645's warn-only->blocking soak pattern; reference
  baseline 37% and this effort's changes.
- Done ceremony per codified pipeline: completeEffort, .planning/done/<date>-
  <effort>/ move, final map addendum with before/after numbers table.

## Acceptance
- Soak issue number recorded in map.
- Re-census numbers recorded.
- done/ folder exists with map/spec/tickets; PR merged.
