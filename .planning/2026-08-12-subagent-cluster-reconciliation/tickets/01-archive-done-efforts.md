---
status: done
---

# 01 — Archive 3 done efforts (tool-split, wayfind-port-new-skills, spawn-seam)

**Status:** Done

## type

`task` (AFK-able; git-move + status stamps, all evidence verified against merged PRs)

## Change

Move three shipped-but-untracked efforts from `.planning/` into `.planning/done/` (via `git mv` to preserve tracked files only), and set each effort's primary doc status to its done/closed form with the cited shipping PR.

Per-effort checklist:

- [x] **`2026-08-10-subagent-tool-split`** → `.planning/done/2026-08-10-subagent-tool-split`. DONE (#1207); its spec status set to `Done (shipped #1207)`. (The 28 never-flipped plan checkboxes are stale tracking, not live work.)
- [x] **`2026-08-08-wayfind-port-new-skills`** → `.planning/done/2026-08-08-wayfind-port-new-skills`. DONE (Batch 1 #1138, Batch 2 #1176); all tickets closed; map status set to `Done (Batch 1 #1138, Batch 2 #1176)`.
- [x] **`2026-08-08-fix-subagent-spawn-seam-tool-gate-core-task`** → `.planning/done/2026-08-08-fix-subagent-spawn-seam-tool-gate-core-task`. Resolved-with-deferrals; map status set to `Done — resolved with deferrals (stage-4 goalState deferred; see reconciliation umbrella)`. The stage-4 goalState deferral is carved into tracked next-step #1 (no home yet).

## Why

These three are fully delivered (or resolved-with-deferrals) but their folders still live under `.planning/` as if active, cluttering the cluster's active set. Archiving them to `.planning/done/` reflects reality and is the repo's close/archive convention (mirrors `kp-cluster-reconciliation` ticket 04).

## Evidence

- `2026-08-10-subagent-tool-split` — shipped #1207.
- `2026-08-08-wayfind-port-new-skills` — Batch 1 #1138, Batch 2 #1176.
- `2026-08-08-fix-subagent-spawn-seam-tool-gate-core-task` — #1 shipped #1127, #2 shipped #1129, #3 stages 1–3 shipped #1132/#1133/#1135, #3 stage-4 (goalState) DEFERRED, #5 reverted (#1142 → reverted via #1145).

## Resolution

All three folders moved to `.planning/done/` with `git mv`; primary-doc status stamps set to done/closed with cited PRs. Stage-4 goalState deferral recorded as tracked next-step #1 on the umbrella map.
