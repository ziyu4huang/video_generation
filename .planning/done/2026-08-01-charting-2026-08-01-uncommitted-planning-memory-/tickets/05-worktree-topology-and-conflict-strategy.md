# 05 — Worktree/branch topology & conflict strategy

---
type: grilling
status: closed
claimed: wayfinder-session
blocked by: 02 (Trigger event & batch granularity)
---

## Question

**Where does the commit land, and how are conflicts handled** given this repo uses a
git-worktree per effort? Memory written in an effort worktree commits to that effort's
branch — it only reaches other worktrees on merge. Two efforts both editing MEMORY.md → a
§-delimited merge conflict when both land.

## What to build

A grilled decision on topology + conflict handling. Candidates:

- **Topology:** commit on the **current branch** whatever it is (effort branch, or `main` if
  the worktree is on main). Decide whether committing straight to `main` from a main
  worktree is allowed or should be suppressed.
- **Conflict strategy** for the §-file across branches:
  - **Append-only semantics + custom merge driver** (`union` / `merge=union` in
    `.gitattributes`) — treats MEMORY.md as a log, never a conflicting rewrite.
  - **Last-write-wins** (the repo's `.planning/` convention per wayfind ADR-0005) — accept
    that merges clobber; simple, loses concurrent branches' edits.
  - **Manual resolution** — surface the conflict to the human; safest, least durable.
- State how this composes with the worktree-per-effort model: is "memory reaches main only
  on effort merge" acceptable, or must an effort's memory be shareable mid-flight?

## Acceptance

- [ ] Topology rule chosen (current-branch; main-commit allowed vs suppressed).
- [ ] Conflict strategy chosen with rationale (union-driver vs last-write-wins vs manual).
- [ ] States whether memory is shareable across worktrees mid-effort or only post-merge,
      and that this is acceptable for "durable."
- [ ] If a merge driver is chosen, names the `.gitattributes` entry + how it's seeded into
      the repo.

## Resolution

**Decision (grilled 2026-08-01): custom §-union merge driver; commit on the current
(non-protected) branch; cross-worktree sharing is post-merge.**

- **Conflict strategy — custom §-union merge driver.** Because both efforts APPEND entries
  at the end of MEMORY.md, a forward-merge of two memory-writing branches conflicts at the
  same insertion point *every time* (not rare) — so manual resolution is too painful and
  last-write-wins would lose the merged-out branch's memory (the opposite of durable). The
  driver splits on `§` (ENTRY_DELIMITER), unions entries by trimmed content (dedup), and
  rejoins: both branches' new entries survive, common base entries aren't duplicated.
  Registered via committed `.gitattributes` (`.agents/memory/MEMORY.md merge=pi-memory`);
  the autocommit hook **self-configures** `git config merge.pi-memory.driver "<script>"` on
  first run (idempotent) — since git merge-driver config is per-clone (not committed), the
  hook owns its bootstrap. True edit-conflicts (same entry changed on both sides) keep both
  versions; consolidation merges them later. Chosen over built-in `merge=union` (lighter,
  travels via .gitattributes alone, but leaves duplicate base entries until
  consolidation/DB-dedup) and `merge=ours` (data loss).
- **Topology — commit on the current branch; SUPPRESS on protected/main.** (On-branch is
  settled by the scope decision.) A commit straight to `main` is suppressed: `main` is
  branch-protected (a local commit couldn't push) and direct-to-main bypasses the
  PR-reviewable value. So auto-commit fires only on feature/effort branches; the main
  worktree's rare memory writes stay uncommitted (on disk; committed when authored in a
  feature worktree or manually). Aligns with the repo's feature-work-in-feature-worktrees
  convention.
- **Cross-worktree sharing — post-merge.** A branch's memory reaches other worktrees only
  after it forward-merges to `main`; other worktrees pick it up on their next session start
  via the self-healing `syncMarkdownMemories` (ticket 07). Memory is NOT shared mid-effort
  across worktrees — acceptable for "durable" (on-disk + committed on its branch).

**Clears fog F2.** The conflict frequency was "dim" at chart; it is now sharp — conflicts
are the DEFAULT outcome whenever two efforts both append memory and forward-merge (the
append-at-end pattern), frequent enough to warrant the automated driver above. F2 resolved.

**Downstream — 06 is now fully unblocked.** Ticket 06's build scope includes the §-union
merge driver + .gitattributes + the self-config git-config bootstrap, alongside the hook
itself (trigger, guards, message). After 05, no design decisions remain before the build.
