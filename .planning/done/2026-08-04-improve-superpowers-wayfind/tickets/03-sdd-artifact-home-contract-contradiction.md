---
type: grilling
status: closed
decision: "Option 1 (chosen 2026-08-05 grilling): no-effort SDD artifacts land in a FLAT, gitignored .planning/sdd/ (no effort subdir) — NOT .superpowers/sdd/. Rationale: keeps ADR-0007's 'unconditional no-.superpowers-write' actually TRUE, gives a single artifact home under .planning/, and leaves the artifact-leak test strict + meaningful. Ad-hoc use preserved (no error). Rejected: Option 2 (soften ADR / weaken test) and Option 3 (require an effort — ADR-0007 already rejected as it kills ad-hoc brainstorming)."
resolution: "Decision (Option 1) implemented + merged via PR #1038 (mergeCommit 5056072b) — no-effort SDD fallback moved from .superpowers/sdd/ to flat gitignored .planning/sdd/; ADR-0007's 'unconditional no-.superpowers-write' now actually true; sdd-workspace + test, .gitignore, pi-tools.md, task-brief/review-package comments, superpowers.ts bootstrap, and ADR-0007 updated; effort path unchanged"
---
# .superpowers/sdd contract contradicts the script that writes there

## Question

The always-injected bootstrap (`src/superpowers.ts` `piBoundaryOverrides`) and ADR-0006 assert `.superpowers/sdd/` is "never written", yet the `sdd-workspace` script's no-effort branch (`skills/subagent-driven-development/scripts/sdd-workspace`) does `mkdir -p "$base/$slug"` under `.superpowers/sdd/` when `PI_PLANNING_EFFORT` is unset — and `tests/sdd-workspace.test.ts` asserts it. The agent is told "never write here" while being handed a tool that writes there on the common ad-hoc path. A genuine fork — grill to pick one truth:

- **(a)** Make `sdd-workspace` / `task-brief` / `review-package` always resolve under `.planning/` (effort or flat) so they match ADR-0006; or
- **(b)** Soften the bootstrap + ADR-0006 wording to "effort-aware: `.superpowers/sdd/` only as a gitignored upstream-faithful fallback".

Then make code + docs + bootstrap agree. (Tickets in the map's fog — the CI-skipped sdd-workspace test and the stale task-brief/review-package headers — graduate from this decision.)
