# 02 — Build the real-git integration suite

---
type: task
status: closed
claimed: wayfinder-session
built: 2026-08-01 (commit 5b923407, rebased branch)
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

- [x] All five scenarios (per 01's scope) **pass** against real `git` in a tmpdir — evidence
      captured (test output) per verification-before-completion before any "done" claim.
- [x] The harness reuses the established tmpdir pattern; no new deps.
- [x] `tsc --noEmit` clean; the full existing suite (941 tests) still green — zero regressions.
- [x] A documented **manual smoke** (opt-in a tmp repo, eyeball a real commit + a real merge)
      as the human-eye final check. *(documented; the run is the human's final acceptance)*
- [x] On green: this ticket + 01 close the map; the parent ticket 08 + the parent effort's
      destination are reached.

## Resolution

**Built & independently verified (2026-08-01).** Built via an isolated TDD implementer (tier
medium, watchdog L2 soft-gate → verified independently). Commit `5b923407` on the branch
rebased onto origin/main, scoped to `tests/` only (src/ untouched).

**Files:** `tests/integration/autocommit-real-git.test.ts` (270 lines, 6 `it`s) +
`tests/helpers/real-git.ts` (167-line tmpdir+git harness: `mkdtemp` → `git init` → local
identity → `.agents/memory/{MEMORY.md,config.json}` → explicit-path initial commit →
feature-branch checkout). Reuses the established `config.test.ts`/`flow.test.ts` tmpdir
pattern; no new deps (node:fs + node:child_process only).

**The five scenarios** (scope 01=A: git-level only for #4):
1. **commit-lands** — append → `message_end` → debounce → NEW commit, fixed message
   `docs(memory): auto-update project memory`, contains only MEMORY.md.
2. **no-sweep (safety guarantee)** — pre-stage `scratch.txt` → trigger → autocommit touches
   **only** MEMORY.md; `scratch.txt` stays staged-but-uncommitted. **Non-vacuous:** the
   implementer regressed the hook's pathspec `git commit` (dropped `-- <relPath>`) and watched
   this test fail for exactly the right reason (`scratch.txt` swept in), then reverted.
3. **branch-switch** — commit on `feature/durable`, NOT on `main` (`git branch --contains`);
   checkout `main` hides the edit.
4. **§-union merge driver (git-level)** — two branches each append a distinct entry → real
   `git merge` → both appends + both common-base entries survive; common base appears exactly
   once (dedup'd); no conflict markers. (No second worktree / no syncMarkdownMemories — parent
   07 owns the re-sync.)
5. **abort-skip** — real `.git/MERGE_HEAD` → skip (no commit); real `.git/index.lock` → defer
   (no commit, no throw, one re-arm).

**Verified independently:** `tsc --noEmit` exit 0; `bun test` → **947 pass / 0 fail** (941
existing + 6 new, zero regressions); commit scope clean (2 test files, src/ diff empty);
assertions spot-checked real (no-sweep + merge-driver + branch-switch all assert on actual
git state).

**This map is complete** — both tickets closed; the destination (real-git proof of all 5
durability properties) is reached. The manual smoke remains the human's final acceptance.
