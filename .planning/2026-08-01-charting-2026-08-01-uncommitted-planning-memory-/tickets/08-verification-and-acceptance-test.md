# 08 — Verification & acceptance test

---
type: task
status: open
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

- [ ] Test written and **passing** (`bun test` in the owning package), demonstrating all
      five properties above.
- [ ] Run per `verification-before-completion`: evidence (test output) captured before any
      "done" claim.
- [ ] On green, this ticket + 06 close the map; the destination is reached.

## Resolution

_(open)_
