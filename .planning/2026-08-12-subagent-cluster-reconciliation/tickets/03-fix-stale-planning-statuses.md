---
status: done
---

# 03 — Fix stale .planning statuses (8 efforts) + 5 core-task-review ticket frontmatters

**Status:** Done

## type

`task` (AFK-able; each flip verified against its merged shipping PR)

## Change

Flip stale `.planning` status stamps that still read `Draft`/`Approved`/`proposed`/`active`/`open` to their shipped Done/Closed form, citing the shipping PR for each. Two groups:

### Group A — 8 effort-level status flips

| # | Effort (file) | Old status text | New status text |
|---|---|---|---|
| 1 | `2026-08-10-superpowers-tighten-and-document/spec.md` | `status: Draft (pending review)` | `status: Done (shipped #1235)` |
| 2 | `2026-08-11-superpowers-bootstrap-trim/plan.md` | `status: active` | `status: Done (shipped #1241)` |
| 3 | `core-runtime-extraction/spec.md` | `Status: Approved (design — pending implementation plan)` | `Status: Done (shipped #1251)` |
| 4 | `2026-08-09-subagent-workflow-tsconfig-strictness/spec.md` | `Status: Approved design — pending implementation.` | `Status: Done (shipped #1165)` |
| 5 | `2026-08-09-subagent-tui-toolcall-pairing/spec.md` | `Status: proposed` | `Status: Done (shipped #1161)` |
| 6 | `2026-07-31-core-task-quota-retry/spec.md` | `Status: Design approved; ready for implementation plan` | `Status: Done (shipped #969)` |
| 7 | `2026-07-31-core-task-length-continue/spec.md` | `Status: Design approved; ready for implementation plan` | `Status: Done (shipped #966)` |
| 8a | `2026-08-02-core-task-review/` (effort status) | (open/in-progress) | `Closed (all 14 tickets shipped, #1262)` |

### Group B — 5 `2026-08-02-core-task-review` ticket frontmatters

| Ticket | Frontmatter flip |
|---|---|
| #12 | `status: open` → `status: closed` |
| #10 | `status: open` → `status: closed` |
| #08 | `status: open` → `status: closed` |
| #14 | `status: open` → `status: closed` |
| #16 | `status: open` → `status: closed` |

The reviewer confirmed #1262 closed the entire `2026-08-02-core-task-review` effort (all 14 tickets shipped), so flipping the effort status (8a) and these 5 still-open ticket frontmatters to closed matches reality.

## Why

Status stamps that lag merged reality mislead planning: a spec that reads "Approved — pending implementation" while its code is already on `main` looks like live backlog. De-staling these to `Done (shipped #<PR>)` / `Closed (...)` makes the `.planning/` set a trustworthy baseline. Mirrors the `kp-cluster-reconciliation` staleness-reconciliation pass (commit `cede3335` "reconcile stale status stamps to merged reality").

## Resolution

All 8 effort-level flips applied (with cited shipping PRs); effort `2026-08-02-core-task-review` marked `Closed (all 14 tickets shipped, #1262)`; 5 ticket frontmatters (#12, #10, #08, #14, #16) flipped `status: open` → `status: closed`. Any material deviation in the actual old-status text (versus the hint) is recorded in the reconciliation report.
