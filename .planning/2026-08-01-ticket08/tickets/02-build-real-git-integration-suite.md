# 02 — Build the real-git integration suite

---
type: task
status: open
blocked by: 01 (Cross-worktree / re-sync scope)
---

## Question

Write the real-git integration test suite that proves all five parent-ticket-08 properties
against actual `git` (not mocks) — the closing check that the destination is reached.

## What to build

A `buntest` suite (e.g. `tests/integration/autocommit-real-git.test.ts`) using a tmpdir+`git`
harness (precedented — see map Notes) that drives `realGitOps` (and/or the hook via an
injectable scheduler) end-to-end. One harness, five scenarios (TDD — write each failing test,
watch it fail, implement/verify):

1. **commit-lands:** opted-in repo → write MEMORY.md → `message_end` settle (debounce) →
   assert a commit exists on the current branch with the fixed message + MEMORY.md.
2. **no-sweep (the safety guarantee):** pre-stage an UNRELATED file → trigger the commit →
   assert ONLY `.agents/memory/MEMORY.md` is in the commit (the unrelated file stays
   staged-but-uncommitted). This is the property mocks provably can't reach — the highest
   value of the suite.
3. **branch-switch:** the commit lands on the feature branch, NOT on another branch; switching
   branches shows/hides it correctly.
4. **§-union merge driver:** two branches both append to MEMORY.md → `git merge` → assert BOTH
   entries survive and common base entries aren't duplicated (the driver runs). Self-config
   (`git config merge.pi-memory.driver`) OR set the driver directly in the test harness. Cross-
   worktree reach per the scope decision (01): A=git-level merge only, B=+second worktree +
   sync, C=skip 4b.
5. **abort-skip:** create a real mid-merge state (`.git/MERGE_HEAD`) → trigger → assert NO
   commit (skip, not corrupt). Optionally: real `.git/index.lock` → defer+re-arm.

Per the scope decision (01): build property 4's cross-worktree reach accordingly.

## Acceptance

- [ ] All five scenarios (per 01's scope) **pass** against real `git` in a tmpdir — evidence
      captured (test output) per verification-before-completion before any "done" claim.
- [ ] The harness reuses the established tmpdir pattern; no new deps.
- [ ] `tsc --noEmit` clean; the full existing suite (941 tests) still green — zero regressions.
- [ ] A documented **manual smoke** (opt-in a tmp repo, eyeball a real commit + a real merge)
      as the human-eye final check.
- [ ] On green: this ticket + 01 close the map; the parent ticket 08 + the parent effort's
      destination are reached.

## Resolution

_(open)_
