---
type: grilling
status: open
blocked by: [02-sdd-helper-scripts-on-pi]
---

## Question

How do the SDD file-handoff helpers (`task-brief`, `review-package`, `sdd-workspace`) reach the Pi controller, given they already run as bash scripts (ticket 02)?

- **A — Document + shell-out.** Leave the bash scripts in place; update `pi-tools.md` glue to name their Pi paths and instruct the driving skill to invoke them via `bash`. Zero new code; relies on the controller running `bash` correctly with the right CWD (respecting the no-top-level-`cd` rule — use `bash scripts/task-brief …` with absolute/CWD-resolved paths).
- **B — In-tool wrappers.** Add thin helpers (a companion tool, or `subagent` tool options) that produce the brief/diff file in-process, so the controller doesn't shell out. More robust but duplicates working bash.
- **C — Hybrid.** Document the bash path as primary; add a tiny `subagent`-tool convenience only if shell-out proves fragile.

Also decide where the brief/report/diff files live on Pi (SDD uses a scratch dir under the plan's tree; Pi equivalent under `.planning/<effort>/` or the worktree).

## First takeable step

Run `scripts/task-brief` and `scripts/review-package` for real against a tiny plan in this repo; confirm output paths + that the controller can pass them into a `subagent` dispatch. If clean, A is likely sufficient.
