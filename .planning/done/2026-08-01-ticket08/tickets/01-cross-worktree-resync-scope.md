# 01 — Cross-worktree / re-sync scope

---
type: grilling
status: closed
claimed: wayfinder-session
---

## Question

Parent-ticket-08 property 4 is "the edit survives a branch switch, and **appears after a
merge** to another branch (cross-worktree durability)." How far does ticket 08's verification
reach on the *cross-worktree* axis? The parent effort's ticket 07 already proved
`syncMarkdownMemories` is an idempotent upsert (the re-sync mechanism); the question is
whether 08 re-proves the full merge→re-sync round-trip or relies on 07 and stops at git-level.
This decides how heavy property 4 of the build (ticket 02) gets.

## Options (to grill)

- **A — Git-level only (recommended):** prove the merge **lands the unioned MEMORY.md** on the
  target branch (real `git merge` of two branches that both appended → assert both entries
  survive, dedup'd). Rely on ticket 07 for the re-sync (don't re-run `syncMarkdownMemories`
  in a second worktree). Clean separation: 08 owns "the file lands via merge," 07 owns "the DB
  re-derives." Matches the parent map's framing ("cross-worktree sharing is post-merge — other
  worktrees pick it up via 07's self-healing sync").
- **B — Full round-trip:** git-level merge + a second `git worktree` + actually run
  `syncMarkdownMemories` + assert the DB re-derives the merged entries. Strongest end-to-end
  evidence; heaviest; re-tests ticket 07's territory.
- **C — Skip cross-worktree:** don't test property 4b at all; rely on 07 + the merge-driver
  test (property 4a, the union itself). Lightest; leaves the "appears after merge" property
  unproven by 08.

## Resolution

**Decision (grilled 2026-08-01): A — git-level merge only.**

Ticket 08's cross-worktree verification stops at the git level: prove the real `git merge`
**lands the unioned MEMORY.md** on the target branch (two branches both appended → assert both
entries survive, dedup'd, common base not duplicated). It does **not** re-run
`syncMarkdownMemories` in a second worktree or assert the DB re-derives — that is parent ticket
07's proven guarantee (idempotent upsert), not 08's.

- **Clean separation:** 08 owns "the file lands via merge"; 07 owns "the DB re-derives."
  Matches the parent map's framing ("cross-worktree sharing is post-merge — other worktrees
  pick it up via 07's self-healing sync").
- **Lighter + non-redundant:** avoids spinning up a second `git worktree` + invoking the sync
  machinery just to re-test what 07 already proved.
- **Implication for ticket 02 (build):** property 4 = a real two-branch merge asserting the
  §-union MEMORY.md result on the target branch. No second worktree, no syncMarkdownMemories
  in the test. (The merge-driver test is unchanged — it already exercises the union at git
  level.)

Ticket 02 is now **unblocked** — it's the build (the last ticket before the destination).
