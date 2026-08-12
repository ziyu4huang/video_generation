---
status: done
---

# 03 — Fix stale .planning statuses (7 efforts) — core-task-review (#8) already closed by #1262

**Status:** Done

## type

`task` (AFK-able; each flip verified against its merged shipping PR)

## Change

Flip stale `.planning` status stamps that still read `Draft`/`Approved`/`proposed`/`active`/`open` to their shipped Done/Closed form, citing the shipping PR for each. Two groups:

### Group A — 7 effort-level status flips (this pass)

| # | Effort (file) | Old status text | New status text |
|---|---|---|---|
| 1 | `2026-08-10-superpowers-tighten-and-document/spec.md` | `status: Draft (pending review)` | `status: Done (shipped #1235)` |
| 2 | `2026-08-11-superpowers-bootstrap-trim/plan.md` | `status: active` | `status: Done (shipped #1241)` |
| 3 | `core-runtime-extraction/spec.md` | `Status: Approved (design — pending implementation plan)` | `Status: Done (shipped #1251)` |
| 4 | `2026-08-09-subagent-workflow-tsconfig-strictness/spec.md` | `Status: Approved design — pending implementation.` | `Status: Done (shipped #1165)` |
| 5 | `2026-08-09-subagent-tui-toolcall-pairing/spec.md` | `Status: proposed` | `Status: Done (shipped #1161)` |
| 6 | `2026-07-31-core-task-quota-retry/spec.md` | `Status: Design approved; ready for implementation plan` | `Status: Done (shipped #969)` |
| 7 | `2026-07-31-core-task-length-continue/spec.md` | `Status: Design approved; ready for implementation plan` | `Status: Done (shipped #966)` |
| 8a | `2026-08-02-core-task-review/` (effort status) | (open/in-progress) | **NO EDIT — already closed on `origin/main` by #1262** (map frontmatter `status: complete`; discovered during pre-merge rebase) |

### Group B — 5 `2026-08-02-core-task-review` ticket frontmatters — already closed by #1262 (no edit this pass)

| Ticket | State on `origin/main` (post-#1262) |
|---|---|
| #12 | `status: closed` + `resolved:` line (shipped #1067) |
| #10 | `status: closed` + `resolved:` line |
| #08 | `status: closed` + `resolved:` line (shipped #1075 + #1133) |
| #14 | `status: closed` + `resolved:` line |
| #16 | `status: closed` + `resolved:` line |

These were **already closed on `origin/main`** by #1262 (verified during the pre-merge rebase onto current main). The worktree's snapshot base (`0156022f`) predates #1262, so they read `open` there — but no edit was needed: main already has them closed with richer `resolved:` evidence than this pass would have written.

The reviewer confirmed #1262 closed the entire `2026-08-02-core-task-review` effort (all 14 tickets shipped). During this pass's pre-merge rebase onto current `origin/main`, it was verified that #1262 **already landed on main** and closed the effort in-tree (map `status: complete`; tickets #08/#10/#12/#14/#16 already `status: closed` with `resolved:` lines) — so #8 is a no-op for this pass; only items 1–7 were flipped.

## Why

Status stamps that lag merged reality mislead planning: a spec that reads "Approved — pending implementation" while its code is already on `main` looks like live backlog. De-staling these to `Done (shipped #<PR>)` / `Closed (...)` makes the `.planning/` set a trustworthy baseline. Mirrors the `kp-cluster-reconciliation` staleness-reconciliation pass (commit `cede3335` "reconcile stale status stamps to merged reality").

## Resolution

7 effort-level flips applied (items 1–7, with cited shipping PRs). Item 8 (`2026-08-02-core-task-review`) required **no edit** — verified already-closed on `origin/main` by #1262 during the pre-merge rebase (map `status: complete`; tickets #08/#10/#12/#14/#16 already `status: closed`). Material deviations in actual old-status text (versus the planning hints) are recorded in the reconciliation report.
