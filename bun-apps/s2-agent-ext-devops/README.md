# s2-agent-ext-devops

DevOps tools for the pi coding agent — a **robust, tool-based PR-merge lifecycle** that replaces the brittle agent-side bash polling loops (the `gh pr checks | grep -c` footguns that silently mis-counted checks and wasted turns).

> This package also owns the shared pipeline scripts: `scripts/deploy.ts`, `scripts/run-test.sh`, and `scripts/ci-local.sh` (the repo-root `scripts/ci-local.sh` is a thin wrapper into here). They moved here from `bun-apps/s2-agent/` / repo-root `scripts/`.

## Tools

### `merge_pr_after_local_ci`

A **local-CI-gated** squash merge: runs `run_local_ci` (offline typecheck + tests + gates over the PR's changed packages vs its base), then squash-merges when green **and** the PR is OPEN + not-BEHIND + CLEAN. Blocks — no merge — on red CI, detection error, BEHIND (go re-run `prepare_feature_branch` with `rebase: true`), or a non-CLEAN merge state. No remote CI (disabled in this repo), no polling. Returns merged / aborted + the local-CI tally.

```
merge_pr_after_local_ci({ prNumber: 960 })               // local-CI gate → squash-merge → report
```

Replaces the old recipe (the polling design this package was born to kill):
```bash
for i in 1..N; do
  state=$(gh pr view ...); pending=$(gh pr checks | grep -c ...)   # ← grep -c footgun
  if BEHIND: git fetch && git rebase origin/main && git push --force-with-lease
  gh pr merge --rebase --auto --delete-branch
  wait...
done
```

### `show_pr_status`

One-shot snapshot of a PR's merge state + CI check tally (pass/fail/pending). Lighter than `merge_pr_after_local_ci` when you only need to inspect.

### `sweep_merged_branches`

Classify every local + remote branch and report which are safe to delete. **Conservative + confidence-tiered:**

- a branch is auto-deletable **only** when `gh` shows a MERGED PR for it (`high` confidence);
- uncertain cases — `[gone]` without gh proof, or a head ref reused by an open PR — go to a **`review`** bucket the human decides (never auto-deleted);
- worktree-checked-out, protected (`main`/`master`/default) and the current branch are **never** deleted (absolute — re-guarded at execute time, and `git` itself refuses a worktree-checked-out branch).

Dry-run by default (plan only); `execute:true` deletes the high-confidence set, `confirm:[...]` deletes specific reviewed branches.

```
sweep_merged_branches({})                       // dry-run: returns {deleteLocal, deleteRemote, review, keep}
sweep_merged_branches({ execute: true })        // delete the high-confidence set (re-guarded)
sweep_merged_branches({ confirm: ["feat/x"] })  // human-approved reviewed branch (must be in review)
```

Replaces ad-hoc cleanup bash — critically, it never trusts `git branch --merged` (silently wrong for **squash** merges, the dominant strategy) nor `[gone]` alone (also left by closed-without-merge PRs). Only `gh` PR state is authoritative.

## CLI bins

- `devops-merge-pr-after-ci` (`src/merge-pr-after-ci-cli.ts`) — bash-callable PR finish: preflight → local-CI gate → merge gates → squash-merge → verify_merge_landed → branch cleanup (the TS port of the deleted `scripts/pr-finish.sh`).

## Why

The bash polling loops were (a) brittle — a `grep -c ... || echo 0` doubled the zero-count on no matches, so the loop's break condition never fired (320s timeout wasted); (b) duplicated ad-hoc across every merge. This extension encapsulates the recipe in **tested code** with **structured `gh ... --json`** parsing (no text grep).

The same footgun recurs in **branch cleanup**: `git branch --merged` is silently wrong for squash merges (the branch tip never enters `main`'s history, so almost nothing reads as merged), and `[origin/…: gone]` is left by closed-without-merge PRs too — neither is merge evidence. `sweep_merged_branches` treats only `gh` PR `state=MERGED` as authoritative, routes the uncertain remainder to a human `review` bucket, and hard-guards worktree/protected/current branches.

## Architecture

- `src/pr-logic.ts` — **pure** types shared by the merge recipe (the polling-era `decideRecipeAction` was deleted when polling was removed).
- `src/recipe.ts` — `runMergeRecipe`: the single-shot local-CI-gated squash merge, all I/O behind injectable `SpawnFn` / client interfaces (tested with scripted fakes). `GhClient` is now a type alias of the forge-agnostic `ForgeClient`.
- `src/forge/` — the **forge abstraction** (git-host backends):
  - `types.ts` — `ForgeClient`: the normalized PR/merge contract (`PrSnapshot`, `mergeNow`).
  - `rest.ts` — shared REST transport (injectable fetch; `ForgeHttpError` embeds the response body so failure classification keeps working; the token value never appears in output).
  - `github-rest.ts` — GitHub REST adapter (REST-first backend): pure mappers `mapPullRequest` / `mapChecksRollup` + thin client; union check-runs ∪ commit-statuses rollup; one mergeable-recompute re-GET before UNKNOWN.
  - `gh-cli.ts` — the gh-CLI adapter (fallback backend; the historical impl, moved from `src/gh.ts`).
  - `select.ts` — backend selection: `GITHUB_TOKEN`/`GH_TOKEN` env → `gh auth token` → gh on PATH → abort with remediation. Never anonymous REST; Gitea hosts refused with a pointer to the skeleton.
  - `gitea.ts` — Gitea/Forgejo adapter SKELETON: researched capability map (merge `Do` styles, WIP-prefix drafts, combined-status checks, token auth), not implemented.
- `src/branch-logic.ts` — **pure** branch classification (`classifyBranch`: signals → confidence + bucket). Fully unit-tested, no I/O.
- `src/branch-recipe.ts` — `buildSweepPlan` / `executeSweep` / `runSweep`: the sweep orchestration, I/O behind an injectable `BranchClient` (tested with scripted fakes).
- `src/remote.ts` — `resolveRemoteName` (`DEVOPS_REMOTE` env > `git config devops.remote` > `origin`); consumed by forge selection. Threading it through the recipes' `origin/main` refs is a tracked follow-up.
- `src/gh.ts` — `createBranchClient` (git operations, shared by every forge — git never goes through a forge adapter; the PR listing lives on `ForgeClient.prList`) + pure parsers (`parseBranchVv`, …); re-exports the moved gh-client surface for import stability.
- `extensions/devops.ts` — thin glue: registers the tools, wires the live `Bun.spawn` adapter + `selectForgeClientCached`.

## Install

Registered in `bun-apps/s2-agent/run-dir/manifest.json` (`extensions[]`). The tools are non-tracked by the tool-gate, so they're always active.

## Build & verify tools (absorbed from the former `s2-agent-ext-deploy`)

The extension also owns the two thin build/verify wrappers that previously
lived in a standalone `s2-agent-ext-deploy` package. Each keeps its OWN
owner-declared gating keywords (build/deploy/verify/bundle), distinct from the
PR/merge keywords above. The scripts stay the single source of truth; the tools
only orchestrate + parse.

### `deploy_pi_agent_sh`

Build and deploy the s2-agent bundle + thin extension bundles (mirrors
this package's `scripts/deploy.ts`: codegen → bundle s2-agent.js → thin ext
bundles → factory-verify → freeze). Params: `mode` (bundle|snapshot|standalone|exe,
default bundle), `outDir` (path-guarded to `<repo>/dist/` or `$TMPDIR`),
`noFreeze`. Returns mode, outDir, s2-agent.js size, ext-bundle built/failed
counts, exit code, and a log path.

### `verify_pi_agent_deploy`

Run a `run-test.sh` tier (quick|medium|high|readonly|full, default medium) and
report per-step pass/fail. `high` = the exact CI `deploy -- verify` job.
Params: `tier`, `bail`. Returns steps, exit code, and a log path.

Both resolve the source dirs at runtime (`PI_AGENT_DIR` env or an upward walk
to the sibling `s2-agent/` / `s2-agent-ext-devops/scripts/` pair) and refuse to
spawn if unreachable — `deploy.ts` / `run-test.sh` exist only in the source
repo, never in a deployed bundle. `deploy.ts` still requires
`cwd == bun-apps/s2-agent` (see its `assertCorrectCwd`); the tools spawn it that way.

## Test

```bash
( cd bun-apps/s2-agent-ext-devops && bun test )   # logic + recipes + parsers + CLI fallbacks + branch-logic + branch-recipe
```
