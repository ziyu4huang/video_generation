# 09 — Cross-worktree project-tag coherence

---
type: grilling
status: closed
claimed: wayfinder-session
shipped: 2026-08-01 (commit 78280040)
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

- [x] In/out-of-scope for THIS effort decided (if out, close + leave one line in the map's
      Out-of-scope section).
- [x] If in-scope: stabilization mechanism chosen (git identity / repo config / other) +
      how it composes with the existing `project` filter in `memory_search`.
- [x] Notes the migration concern: entries already indexed under old basename tags.

## Resolution

**Decision (grilled 2026-08-01): IN-SCOPE — stabilize via a repo-local `projectName`
override.** The same repo's 8 worktrees get 8 different project tags (`path.basename(cwd)`),
so a committed MEMORY.md entry indexed in one worktree isn't findable by project tag from
another — and auto-commit (06) made cross-worktree sharing routine, amplifying the divergence.
Chosen over git-identity (adds a fragile git lookup at detect-time, depends on common-dir /
remote) and out-of-scope (cosmetic-only would leave the durability story half-baked for a
worktree-heavy repo).

**Mechanism (shipped, commit `78280040`, TDD):**
- `projectName?: string` added to `MemoryConfig` (`types.ts`).
- The repo-local overlay (`config.ts` `applyRepoLocalProjectMemoryOverlay`) now allows
  `projectName` alongside `autoCommitProjectMemory`/`projectMemoryDir` — **one committed edit**
  to `.agents/memory/config.json` and ALL worktrees of a repo share the tag. Keeps the overlay
  NARROW (still ignores dbBackend/surreal/llm).
- `detectProject` (`project.ts`) gains a backward-compatible optional `projectNameOverride`
  param — wins over `path.basename(cwd)` when set; `memoryDir` follows the override name.
  Stays PURE (no git lookup — the override is a param).
- `index.ts:131` passes `config.projectName` — the SINGLE tag source (sync-markdown-memories
  inherits it via `inRepoProjectName`). Default undefined → cwd basename (zero behavior change
  for repos that don't set it). Composes with the existing `memory_search project=` filter
  unchanged (just a stable value).

**Verified (TDD, independently):** red (watched both new tests fail for the right reasons) →
green: `tsc --noEmit` exit 0; full suite **950 pass / 0 fail** (947 + 3 new: overlay reads
projectName, detectProject honors the override, detectProject falls back to basename).
Backward-compatible (optional param; all existing callers unchanged).

**Migration concern (acceptance #3):** entries already indexed under old basename tags become
orphans when a repo adopts `projectName` — new writes re-tag under the stable name; old
basename-tagged rows linger until consolidation/prune (cosmetic, not data loss). No migration
script shipped; consolidation absorbs it. (This repo is NOT opted into projectName — capability
shipped only.)

**With 09 closed, ALL parent-effort tickets (01–09) are closed → the parent effort is
COMPLETE.**
