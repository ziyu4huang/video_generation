# Wayfinder map: ticket 08 — verify the autocommit hook end-to-end (real-git)

## Destination

Prove the project-memory autocommit hook (built in the parent effort's ticket 06) delivers
**durable project memory end-to-end** — a real-git integration test suite (one tmpdir+git
harness driving `realGitOps`) that demonstrates **all five** parent-ticket-08 properties
against *actual* `git`, not mocks:

1. a write commits to the current branch after the debounce settles;
2. **no unrelated file is swept** (pathspec-limited commit);
3. the edit survives a branch switch;
4. the **§-union merge driver survives a real two-branch merge** (both appends land, dedup'd);
5. an **abort condition** (mid-merge) skips cleanly.

On green + a manual smoke, the parent effort's destination is reached.

## Notes

- **Parent effort.** This map decomposes parent ticket
  `../2026-08-01-charting-2026-08-01-uncommitted-planning-memory-/tickets/08-verification-and-acceptance-test.md`.
  When this map's build ticket closes green, that parent ticket (and the parent effort's
  destination) is reached.
- **Why a map, not a plan.** The hook's *logic* is already covered by 57 mock-based unit
  tests (`tests/handlers/commit-project-memory.test.ts` + `merge-union`/`commit-guards`).
  Ticket 08 closes the **real-git gap** those mocks provably can't reach — and one scope
  decision (cross-worktree) shapes the build.
- **Fact freshness.** This branch is 16 commits behind `origin/main`. Charting is design off
  the *local* state (which holds the hook); **execution of the build must land on a rebased
  branch** — the real-git tests run against the merged hook.
- **Skills every session:** test-driven-development (build), verification-before-completion
  (acceptance), systematic-debugging (build), grilling (the scope ticket).
- **Standing preference:** written artifacts in English; conversation per the live
  `responseLanguage` setting.
- **Research findings (fired at chart):**
  - **Harness is low-risk.** The repo (and hermes-memory itself) has an established
    tmpdir+`mkdtemp` test pattern (`tests/config.test.ts`, `tests/integration/flow.test.ts`,
    `pi-agent`/`pi-agent-cli` e2e tests). A tmpdir + `git init` + spawn-`git` harness is
    well-precedented — no new infra.
  - **Merge-driver script-path is low-risk.** `scripts/pi-memory-merge.mjs` exists where
    `resolveMergeDriverScriptPath` expects (`<pkg>/scripts/`, reached via
    `dirname(import.meta.url)` → `src/` → `../scripts/`). hermes-memory runs from `src/`
    (`main: src/index.ts`, no dist), so `import.meta.url` resolves in place under bun. The
    self-config command should invoke the real script in a tmpdir test. (A test may also set
    its own driver config to control the invocation — either path works.)

## Decisions so far

<!-- The verify-rigor decision was settled at chart (destination-naming grilling) and is
     captured in ## Destination above, not a ticket. -->

- [Cross-worktree / re-sync scope](tickets/01-cross-worktree-resync-scope.md) — **A: git-level
  merge only.** 08 proves the `git merge` lands the unioned MEMORY.md; parent ticket 07 (proven
  idempotent upsert) owns the re-sync. No second worktree / no syncMarkdownMemories in 08's
  test. Ticket 02 (the build) is now unblocked.

## Not yet specified

_(none — the view is clear: one scope decision + the build. The merge-driver test mechanics
and the defer+re-arm real-git test are implementable, not fog.)_

## Out of scope

- **Re-testing `syncMarkdownMemories`** (the merge→DB re-sync) — owned by the parent effort's
  ticket 07 (proven idempotent upsert). Ticket 08 proves the FILE lands via a real merge
  (git-level); the re-sync is 07's guarantee, not re-proven here.
- **Deploying / opting-in a real repo** (e.g. enabling `autoCommitProjectMemory` on this
  repo) — that's a deployment decision, not verification. Verification proves the mechanism
  in a throwaway tmpdir; deployment is a separate effort.
- **The hook's decision logic** — already covered by the 57 mock unit tests; not re-tested.
