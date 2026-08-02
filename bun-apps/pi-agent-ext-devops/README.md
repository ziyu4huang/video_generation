# pi-agent-ext-devops

DevOps tools for the pi coding agent — a **robust, tool-based PR-merge lifecycle** that replaces the brittle agent-side bash polling loops (the `gh pr checks | grep -c` footguns that silently mis-counted checks and wasted turns).

## Tools

### `await_pr_merge`

Poll a PR's CI checks, enable auto-merge when they pass, on `BEHIND` rebase + force-push the feature branch (so checks re-run), and wait for `MERGED`. Returns merged / failed / timed-out + a check tally.

```
await_pr_merge({ prNumber: 960 })               // defaults: strategy=rebase, 600s, auto-delete, auto-force-push-on-BEHIND
await_pr_merge({ prNumber: 960, handleBehind: "fail" })  // opt out of autonomous force-push
```

Replaces the old recipe:
```bash
for i in 1..N; do
  state=$(gh pr view ...); pending=$(gh pr checks | grep -c ...)   # ← grep -c footgun
  if BEHIND: git fetch && git rebase origin/main && git push --force-with-lease
  gh pr merge --rebase --auto --delete-branch
  wait...
done
```

### `pr_status`

One-shot snapshot of a PR's merge state + CI check tally (pass/fail/pending). Lighter than `await_pr_merge` when you only need to inspect.

### `sweep_branches`

Classify every local + remote branch and report which are safe to delete. **Conservative + confidence-tiered:**

- a branch is auto-deletable **only** when `gh` shows a MERGED PR for it (`high` confidence);
- uncertain cases — `[gone]` without gh proof, or a head ref reused by an open PR — go to a **`review`** bucket the human decides (never auto-deleted);
- worktree-checked-out, protected (`main`/`master`/default) and the current branch are **never** deleted (absolute — re-guarded at execute time, and `git` itself refuses a worktree-checked-out branch).

Dry-run by default (plan only); `execute:true` deletes the high-confidence set, `confirm:[...]` deletes specific reviewed branches.

```
sweep_branches({})                       // dry-run: returns {deleteLocal, deleteRemote, review, keep}
sweep_branches({ execute: true })        // delete the high-confidence set (re-guarded)
sweep_branches({ confirm: ["feat/x"] })  // human-approved reviewed branch (must be in review)
```

Replaces ad-hoc cleanup bash — critically, it never trusts `git branch --merged` (silently wrong for **squash** merges, the dominant strategy) nor `[gone]` alone (also left by closed-without-merge PRs). Only `gh` PR state is authoritative.

## Why

The bash polling loops were (a) brittle — a `grep -c ... || echo 0` doubled the zero-count on no matches, so the loop's break condition never fired (320s timeout wasted); (b) duplicated ad-hoc across every merge. This extension encapsulates the recipe in **tested code** with **structured `gh ... --json`** parsing (no text grep).

The same footgun recurs in **branch cleanup**: `git branch --merged` is silently wrong for squash merges (the branch tip never enters `main`'s history, so almost nothing reads as merged), and `[origin/…: gone]` is left by closed-without-merge PRs too — neither is merge evidence. `sweep_branches` treats only `gh` PR `state=MERGED` as authoritative, routes the uncertain remainder to a human `review` bucket, and hard-guards worktree/protected/current branches.

## Architecture

- `src/pr-logic.ts` — **pure** decision logic (`decideRecipeAction`: state + checks → next action). Fully unit-tested, no I/O.
- `src/recipe.ts` — `runMergeRecipe`: the polling loop, all I/O behind injectable `GhClient` / `Sleeper` / `clock` interfaces (tested with scripted fakes).
- `src/branch-logic.ts` — **pure** branch classification (`classifyBranch`: signals → confidence + bucket). Fully unit-tested, no I/O.
- `src/branch-recipe.ts` — `buildSweepPlan` / `executeSweep` / `runSweep`: the sweep orchestration, I/O behind an injectable `BranchClient` (tested with scripted fakes).
- `src/gh.ts` — the real `GhClient` / `BranchClient` wrapping the `gh` / `git` CLI via `Bun.spawn`; pure JSON/text parsers (`parsePrView`, `parseChecks`, `parseBranchVv`, `parseMergedPrs`, …).
- `extensions/devops.ts` — thin glue: registers the tools, wires the live `Bun.spawn` adapter.

## Install

Registered in `bun-apps/pi-agent/run-dir/manifest.json` (`extensions[]`). The tools are non-tracked by the tool-gate, so they're always active.

## Test

```bash
( cd bun-apps/pi-agent-ext-devops && bun test )   # 91 tests: logic + recipe + parsers + entry + branch-logic + branch-recipe
```
