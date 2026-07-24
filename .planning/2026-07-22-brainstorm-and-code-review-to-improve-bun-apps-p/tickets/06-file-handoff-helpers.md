---
type: grilling
status: closed
blocked by: [02-sdd-helper-scripts-on-pi]
claimed: chart-session-2026-07-22
---

## Question

How do the SDD file-handoff helpers (`task-brief`, `review-package`, `sdd-workspace`) reach the Pi controller, given they already run as bash scripts (ticket 02)?

- **A — Document + shell-out.** Leave the bash scripts in place; update `pi-tools.md` glue to name their Pi paths and instruct the driving skill to invoke them via `bash`. Zero new code; relies on the controller running `bash` correctly with the right CWD (respecting the no-top-level-`cd` rule — use `bash scripts/task-brief …` with absolute/CWD-resolved paths).
- **B — In-tool wrappers.** Add thin helpers (a companion tool, or `subagent` tool options) that produce the brief/diff file in-process, so the controller doesn't shell out. More robust but duplicates working bash.
- **C — Hybrid.** Document the bash path as primary; add a tiny `subagent`-tool convenience only if shell-out proves fragile.

Also decide where the brief/report/diff files live on Pi (SDD uses a scratch dir under the plan's tree; Pi equivalent under `.planning/<effort>/` or the worktree).

## First takeable step

Run `scripts/task-brief` and `scripts/review-package` for real against a tiny plan in this repo; confirm output paths + that the controller can pass them into a `subagent` dispatch. If clean, A is likely sufficient.

## Resolution

**A' — inline bash, documented verbatim in `pi-tools.md`.** The controller does NOT call the byte-identical scripts; it runs the extraction/generation inline via standard tools, writing files under `.planning/<effort>/sdd/` per rule 3. This is the SAME philosophy rule 3 already established for `sdd-workspace` ("don't call the script, do it directly"), extended consistently to `task-brief` + `review-package`.

- **sdd-workspace** — retired (rule 3: agent uses `.planning/<effort>/sdd/` directly, `mkdir -p briefs/ reports/`).
- **task-brief** — controller runs the **verbatim fence-aware awk** (copied from the script into pi-tools.md) to extract Task N's section → `.planning/<effort>/sdd/briefs/task-<N>-brief.md`. Context-economical: `bash` returns only the path/line-count, the task text never loads into the controller's context. Validated BSD-awk-compatible on macOS.
- **review-package** — trivial inline: `{ git log --oneline A..B; git diff --stat A..B; git diff -U10 A..B; } > .planning/<effort>/sdd/reviews/review-<base7>..<head7>.diff`.

**Why not B (tool surface):** there is no cross-extension consumer — file-handoff is the controller's own dispatch-prep, not a surface other extensions call. The thin-glue / rule-3-consistency consideration dominates; a TS tool would deviate from the established "byte-identical skill + thin pi glue" convention without a programmatic-invocation payoff (unlike tickets 04/09, which exposed machine-readable/programmatic surfaces other code consumes).

**Why not A (shell-out to scripts):** the scripts live in the extension's skill dir (`bun-apps/pi-agent-ext-superpowers/skills/.../scripts/`), NOT under the working repo's CWD. When the agent works in a project that doesn't contain the extension source, the relative path doesn't resolve — shell-out is only reliable when this monorepo IS the working repo. Inline bash (awk/git) is portable across all projects.

**Implication:** ticket 06 is a **decision ticket** (no runtime code). Implementation = documenting the verbatim awk + git commands in `pi-tools.md`, **absorbed by ticket 11** (which already carries the rule-3 workspace doc). A' keeps superpowers as "byte-identical + thin glue" and the workflow ext focused on orchestration.
