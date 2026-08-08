---
type: task
status: closed
---

# 05 — await_pr_merge: validate rebase target against PR headRefName

## Finding (codebase review M1)

`await_pr_merge` (extensions/devops.ts) resolves the branch to rebase via `params.branch ?? currentBranch(spawn)`. The default `handleBehind="rebase-force-push"` then calls `gh.rebaseAndForcePush(branch)` (recipe.ts -> gh.ts): `git rebase origin/main` + `git push --force-with-lease origin <branch>`. If invoked while NOT on the PR head (e.g. sitting on `main` — common), the rebase targets `main`: at best a no-op that leaves the PR behind (loop spins to timeout, wasted budget); at worst it rewrites/force-pushes the wrong branch. The PR's real head ref is available via `gh pr view --json headRefName` but is never fetched. No test covers this default path (recipe.test.ts always passes branch:"feat-x").

## Acceptance

- Fetch the PR's `headRefName` (via `gh pr view --json headRefName`).
- Default `branch` to `headRefName` (not currentBranch()), OR assert `currentBranch() === headRefName` and fail loudly on mismatch BEFORE any rebase/force-push.
- Add a regression test for the default path (no `branch` param): on-head proceeds; off-head fails loudly (no force-push).
- Never force-push a branch that isn't the PR's head.

## Resolution — RESOLVED-BY-04 (moot)
M1 is moot: ticket 04 (#1054) removed the entire rebase/force-push path this ticket targets. The GhClient interface now exposes only prStatus + mergeNow (no rebaseAndForcePush); mergeState==="BEHIND" simply blocks (src/recipe.ts: "rebase locally + re-push, then re-run"). currentBranch() is no longer called in the merge path (survives only in branch-recipe.ts for sweep_branches). entry.test.ts already guards the dropped branch/handleBehind params are absent. The hazard no longer exists; no code change.
