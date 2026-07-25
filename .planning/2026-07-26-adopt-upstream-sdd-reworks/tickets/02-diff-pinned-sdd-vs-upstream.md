## Question

What exactly differs between the fork's currently-pinned SDD files and upstream's current versions? (Grounds the ADR-0004 re-pin — which bytes change.)

**type:** research (AFK)
**claimed:** wayfinder-chart
**blocked by:** —

## Resolution

Diffed `bun-apps/pi-agent-ext-superpowers/skills/subagent-driven-development/` vs `../superpowers/skills/subagent-driven-development/` (working tree; fork 13 behind origin/main):

- **SKILL.md**: fork 418 → upstream **503 lines (+85)**. The bulk of the rework (lifecycle reorg, convergent fix-loop, rationalization table).
- **implementer-prompt.md**: fork 139 → 142 (+3). Near-identical.
- **task-reviewer-prompt.md**: fork 188 → 185 (−3). Near-identical.
- **re-review-prompt.md**: **NEW in upstream — fork LACKS it.** Re-pin must ADD this file (the fix-loop's scoped re-review prompt).
- **scripts/** (`task-brief`, `review-package`, `sdd-workspace`): all DIFFER — but these are **fork-customized pi-port glue** (effort-aware `sdd-workspace` from W2c), NOT pinned. They need reconciliation with the plan-scoped interface (ticket 06), not blind re-pin.

**Net:** the re-pin is dominated by `SKILL.md` (+85) + adding `re-review-prompt.md`. The two prompt files are near-identical (+/−3 lines).
