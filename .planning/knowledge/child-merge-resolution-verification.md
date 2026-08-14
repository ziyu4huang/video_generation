# Child-resolved merges: verify feature sentinels before shipping

## Lesson (2026-08-15, PR #1334)

While PR #1334 was open, a parallel session merged overlapping budget features (#1329/#1332/#1335). A dispatch child resolved the branch merge by taking main's agent.ts wholesale — silently deleting the entire grace-turn feature; the feature's own test file couldn't even load (`Export 'BUDGET_WRAP_UP_MESSAGE' not found`), and tsc stayed green because tsconfig only includes src/**.

Hard rules:
1. After ANY child-resolved merge touching feature files: grep the feature's exported symbol AND run its test file before shipping. Green tsc ≠ feature survived.
2. Merge/ship dispatches must be ultra-minimal enumerated commands ("EXACTLY these, nothing else") — the 537k budget death was a merge child improvising a sync+merge+test-fix detour.
3. Watchdog commit-scope flags fire even when watchdog is omitted; on instructed-file commits they are expected noise (pass commitScope matching instructed paths to silence).
