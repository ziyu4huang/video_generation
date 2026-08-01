# 09 — Cross-worktree project-tag coherence

---
type: grilling
status: open
---

## Question

The in-repo project memory is tagged in the global DB with `project.name =
path.basename(cwd)` (`detectProject`, `project.ts`). This repo's 8 git worktrees have 8
different basenames (`git worktree list`), so the **same committed MEMORY.md** — synced
from different worktrees — lands under **different project tags**, and the dedup key
includes `project`, so it does **not** dedupe across them. Auto-commit (ticket 06)
amplifies this by making cross-worktree MEMORY.md sharing routine.

Is stabilizing the tag in scope for THIS effort, and if so, how should the in-repo
project-memory tag be **stabilized across worktrees** so a committed entry is findable
under one consistent project name?

## What to build

A grilled decision. Candidates:

- **Stabilize to git identity** — tag with the `git rev-parse --show-toplevel` basename
  (the repo's main name) or the remote origin name, instead of cwd basename. Consistent
  across worktrees of one repo; needs a git lookup at detect-time.
- **Stabilize via repo-local config** — a `projectName` key in `.agents/memory/config.json`
  (the file ticket 01 introduced) overriding the basename. Explicit, travels with the repo.
- **Accept divergence (out of scope)** — the duplication is cosmetic (content is still
  findable via unfiltered `memory_search`); close as out-of-scope and spin a separate
  effort only if it bites.

Pre-existing (detectProject behavior); amplified by this effort's auto-commit (ticket 06).

## Acceptance

- [ ] In/out-of-scope for THIS effort decided (if out, close + leave one line in the map's
      Out-of-scope section).
- [ ] If in-scope: stabilization mechanism chosen (git identity / repo config / other) +
      how it composes with the existing `project` filter in `memory_search`.
- [ ] Notes the migration concern: entries already indexed under old basename tags.

## Resolution

_(open)_
