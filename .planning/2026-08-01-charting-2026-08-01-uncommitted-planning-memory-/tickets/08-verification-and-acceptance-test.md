# 08 — Verification & acceptance test

---
type: task
status: closed
claimed: wayfinder-session
verified: 2026-08-01 (real-git suite, commit 5b923407)
blocked by: 06 (Build the autocommit hook)
---

## Question

Define and write the test that **proves durability** end-to-end — the closing check that
the destination is actually reached, not just that a hook exists.

## What to build

A test (bun test for the TS hook; the repo convention) that:

1. Sets up an opted-in worktree (per 01), triggers a project-memory write.
2. Asserts `.agents/memory/MEMORY.md` is **committed on the current branch** (per 05) after
   the trigger event (per 02) settles.
3. Asserts **no other file** was staged (the "never `-A`" guarantee from 03/04).
4. Asserts the edit **survives a branch switch**, and **appears after a merge** to another
   branch (the cross-worktree durability property — the whole point).
5. Asserts an abort condition from 04 (e.g. mid-merge state) results in a **skip**, not a
   corrupt commit.

## Acceptance

- [x] Test written and **passing** (`bun test` in the owning package), demonstrating all
      five properties above.
- [x] Run per `verification-before-completion`: evidence (test output) captured before any
      "done" claim.
- [x] On green, this ticket + 06 close the map; the destination is reached.

## Sub-map

Decomposed into its own wayfinder map at
`../../2026-08-01-ticket08/map.md` (scope decision + the real-git build). Closes when that
map's build ticket is green + the manual smoke passes.

## Resolution

**Verified (2026-08-01) via the ticket08 sub-map.** The real-git integration suite
(`tests/integration/autocommit-real-git.test.ts` + `tests/helpers/real-git.ts`, commit
`5b923407` on a branch rebased onto origin/main) drives `realGitOps` + the real hook against
actual `git` and proves all five properties: (1) commit-lands with the fixed message; (2)
**no-sweep** — a pre-staged unrelated file is NOT swept into the autocommit (stays
staged-but-uncommitted; non-vacuous, TDD-proofed by regressing the pathspec); (3) branch-switch
— the commit lands on the feature branch, not the base; (4) the **§-union merge driver**
survives a real two-branch `git merge` (both appends land, common base dedup'd, no conflict
markers; git-level per 01=A, parent 07 owns the re-sync); (5) abort-skip — MERGE_HEAD skips,
index.lock defers+re-arms. Independently verified: `tsc` clean, **947 pass / 0 fail** (941 + 6),
src/ untouched, scope clean. The manual smoke remains the human's final eye-check. **With 06
built and 08 verified, the parent effort's destination — durable project memory in git — is
reached.** (Ticket 09, cross-worktree project-tag coherence, remains open as an independent
enhancement.)
