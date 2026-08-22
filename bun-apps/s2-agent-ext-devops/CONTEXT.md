# s2-agent-ext-devops

DevOps tools for the pi coding agent — a **tool-based** PR-merge / branch /
local-CI lifecycle that replaces brittle agent-side bash polling loops. All
`gh`/`git` output is parsed as structured JSON (no `grep -c` footguns); the full
recipes live in tested code (`src/`). The package also owns the shared pipeline
scripts — `scripts/run-test.sh`, `scripts/ci-local.sh` (runnable entries); the deploy library lives in `src/deploy/` (`run.ts` + `lib/`).

## Tools

### PR / merge / branch / CI tools
- **merge_pr_after_local_ci** — a LOCAL-CI-GATED merge. Runs `run_local_ci` (offline
  typecheck+tests+gates over the PR's changed packages vs its base), then
  squash-merges when green + CLEAN. Blocks on red CI / detection error / BEHIND /
  non-CLEAN. No remote CI (disabled in this repo), no polling.
  _Avoid_: auto-merge, ship tool (it is a CI-GATED merge that blocks on red /
  BEHIND / non-CLEAN — never an unconditional merge)
- **show_pr_status** — one-shot PR snapshot (state + mergeState + check tally). An
  ungated companion (always active).
  _Avoid_: pr check, status poll (it is a one-shot snapshot — no remote CI, no polling)
- **sweep_merged_branches** — classify + (dry-run by default) delete merged
  local/remote branches. Conservative: only `gh`-confirmed MERGED PRs are
  auto-deletable; uncertain cases go to a `review` bucket. A branch checked out
  in any worktree is never deleted, LOCAL OR REMOTE — the guard protects the
  person in that worktree (push target + upstream), not the checkout.
  _Avoid_: branch cleanup, prune (it is a conservative classifier with a review
  bucket — not a delete-what-looks-merged sweep)
- **run_local_ci** — OFFLINE local CI: typecheck + tests scoped to changed packages
  vs `origin/main`, plus every step of the workflow's `regression-gates` job.
  Structured pass/fail; self-verify before `gh ship` (merge_pr_after_local_ci gates on
  this). BOTH halves are derived from `.github/workflows/ci.yml.disabled` and
  neither is hand-copied here: a package's test command from its `tests` matrix
  row (`src/ci-matrix.ts`), the gate list from the `regression-gates` job
  (`src/ci-gates.ts`). Matrix rows run via `bash -c` — so `--isolate`,
  `&& bun run qa`, and build-first rows are honored exactly as remote CI would;
  only packages with NO matrix row fall back to the generic `bun run test`.
  `scripts/ci-local.sh` parses the same two blocks, so the runners cannot
  disagree. An unparseable gate job FAILS the run (`gateError`) rather than
  degrading to an empty, all-green gate set.
  _Avoid_: run tests, pre-push check (it is change-scoped CI — package test
  command AND gate suite both derived from the disabled workflow, never hand-copied)
- **check_main_health** — "is the default branch green right now?" Runs the FULL
  matrix + the whole gate suite in the worktree that HOLDS the default branch
  (a suite runs against a working tree, not a ref, so running it elsewhere would
  report that tree's health under main's name). Read-only. ABORTS — reporting
  unhealthy — when no worktree holds it; a dirty/behind tree still runs but the
  outcome warns that the verdict is about that tree, not `origin/<default>`.
  Exists because `run_local_ci` is change-scoped and remote CI is disabled, so a
  branch avoiding a broken package merges green forever and nothing reports that
  main itself is red. Thin over `runLocalCi({all:true})` — no second engine.
  _Avoid_: full CI, main check (it is the default-branch-in-its-worktree health
  probe — the complement to change-scoped run_local_ci, not a bigger re-run)
- **CLI fallbacks** (`src/*-cli.ts`, all in `bin`) — every owned phase is
  reachable from a non-pi session: `main-health-cli`, `sweep-merged-branches-cli`,
  `local-ci-cli`, `prepare-feature-branch-cli`, `verify-merge-cli`, plus the pre-existing
  `sync-default-branch-cli` / `merge-pr-after-ci-cli`. Shared contract in
  `src/cli-common.ts`: JSON on stdout, diagnostics on stderr, exit 0/1/2. They
  parse argv and serialize — nothing else — so a wrapper cannot drift from its
  recipe's guards.
  _Avoid_: scripts, thin wrappers (they are argv-parse + serialize ONLY — a
  wrapper cannot re-implement or soften the recipe's guards)
- **changed-packages CLI** (`src/changed-packages-cli.ts`) — the bash-callable
  wrapper the workflow's `changed_packages` job shells out to (`--all`, or
  `<baseRef> <headRef>` → one line of JSON). Deliberately a plain script entry,
  not an `extensions/cli-subcommand.ts`: that job runs before any `bun install`.
  _Avoid_: cli subcommand (it is a pre-install plain script entry by design —
  subcommand registration would assume an installed workspace)
- **devops-merge-pr-after-ci bin** (`src/merge-pr-after-ci-cli.ts`) — bash-callable PR finish
  (preflight → local-CI gate → merge gates → squash-merge → verify_merge_landed →
  branch cleanup); the TS port of the deleted `scripts/pr-finish.sh`.
  _Avoid_: pr-finish.sh, ship script (the bash script is DELETED — this bin is
  the only PR-finish entry)
- **sync_default_branch** — sync this worktree/repo to the latest default branch
  (full/rebase/pull; worktree-aware; aborts on divergent unless `force`).
  **Preserves auto-managed hot files**: the default advance aborts `dirty_tree`
  on uncommitted work, EXCEPT preserve-listed paths (default
  `.agents/memory/MEMORY.md` — hermes-managed, dirty in ~every worktree) which
  are stashed before the advance and restored after. Override via `preserve:`;
  `preserve: []` disables it (strict gate). Outcomes carry `preserved?:
  { paths, restored, conflict? }`.
  _Avoid_: git pull, branch update (it is a worktree-aware sync with hot-file
  preserve semantics — not a bare pull)
- **run_devops_retrospect** — advisory post-run anomaly review (never blocks).
  _Avoid_: audit, review gate (it advises only — nothing downstream blocks on it)
- **prepare_feature_branch** — worktree-aware branch prepare (create / rebase /
  force-push-with-lease). Covers the BEHIND state.
  _Avoid_: branch create, checkout helper (it covers the full BEHIND-state prep —
  create AND rebase AND force-push-with-lease)
- **verify_merge_landed** — post-merge verify (merge state + file scope CLEAN/CONTAMINATED
  + branch-spent). Reads the merge commit with `git show --numstat`, NOT `--stat`:
  `--stat` renders for a terminal and abbreviates long paths as `.../tail`, which
  broke every `startsWith(expectedScope)` check and called a clean merge
  CONTAMINATED. `branchSpent` keys off gh's `headRefOid` rather than ancestry,
  because a squash merge (this repo's convention) makes the head ref an ancestor
  of nothing.
  _Avoid_: post-merge check (it is scope verification — CLEAN/CONTAMINATED file
  scope + branch-spent, read via `--numstat` not `--stat`)

### Build & verify tools (absorbed from the former `s2-agent-ext-deploy`)
Two thin tools that wrap the existing build/verify/deploy scripts. Each keeps
its OWN owner-declared gating keywords (build/deploy/verify/bundle/dist),
distinct from the PR/merge keywords above.

- **deploy_pi_agent_sh** — build + deploy the s2-agent bundle + thin extension bundles.
  Mirrors this package's deploy library `src/deploy/run.ts` (codegen → bundle → ext bundles
  → factory-verify → freeze). Params: `mode` (bundle|snapshot|standalone|exe,
  default bundle), `outDir` (path-guarded to `<repo>/dist/` or `$TMPDIR`),
  `noFreeze`.
  _Avoid_: build script (it is the full deploy pipeline — codegen → bundle → ext
  bundles → factory-verify → freeze — not a compile step)
- **verify_pi_agent_deploy** — run a `run-test.sh` tier (quick|medium|high|readonly|full,
  default medium). `high` = the exact CI `deploy -- verify` job. Params:
  `tier`, `bail`.
  _Avoid_: smoke test (it runs a `run-test.sh` TIER, where `high` is the exact
  CI job — not an ad-hoc ping)

## Layout
- `extensions/devops.ts` — registered entry; thin glue registering every tool.
- `src/pr-logic.ts` / `src/branch-logic.ts` — PURE decision logic (unit-tested).
- `src/recipe.ts` / `src/branch-recipe.ts` / `src/ci-recipe.ts` / `src/sync-recipe.ts`
  / `src/retrospect-recipe.ts` / `src/prepare-recipe.ts` / `src/verify-merge-recipe.ts`
  — orchestration, I/O behind injectable clients (tested with fakes).
- `src/forge/` — the forge abstraction (git-host backends, REST-first):
  `types.ts` (`ForgeClient` — the normalized PR/merge contract; `GhClient` in
  recipe.ts is its alias), `rest.ts` (shared REST transport; errors embed the
  response body; token never in output), `github-rest.ts` (GitHub REST adapter
  + pure mappers), `gh-cli.ts` (gh-CLI fallback, the historical impl),
  `select.ts` (backend selection: GitHub hosts — env token → `gh auth token`
  → gh on PATH → abort; Gitea hosts — naming heuristic or `DEVOPS_FORGE=gitea`
  — require `GITEA_TOKEN`), `gitea.ts` (Gitea/Forgejo REST adapter:
  `token`-scheme auth, boolean `mergeable` mapping, commit-statuses checks,
  `rebase-merge` style mapping).
- `src/remote.ts` — `resolveRemoteName` (`DEVOPS_REMOTE` env >
  `git config devops.remote` > `origin`); consumed by forge selection
  (`SelectedForge.remoteName`) AND threaded through
  `createBranchClient(spawn, remoteName)` + every recipe's `remoteName`
  option — all `git fetch/push` args and `<remote>/<branch>` refs follow it.
- `src/gh.ts` — `createBranchClient(spawn, remoteName?)` (git ops — shared by
  every forge; git never goes through a forge adapter, and the PR listing
  lives on `ForgeClient.prList`; the remote-facing methods
  `remoteBranches`/`defaultBranch`/`deleteRemoteBranch` are scoped to
  `remoteName`) + pure JSON/text parsers (re-exports the
  gh-client surface that moved to `src/forge/gh-cli.ts`).
  `BranchClient.dirtyPaths(dir)` lists TRACKED dirty
  paths (repo-relative; excludes untracked/ignored) via `git status --porcelain=v1`;
  `isClean` remains for other recipes. `SyncClient` now `Pick`s `dirtyPaths`
  (not `isClean`) so the per-path preserve split runs on one query.
- `src/deploy-argv.ts` — PURE param→argv mapping for deploy_pi_agent_sh/verify_pi_agent_deploy
  (unit-tested, isolated from spawning).
- `src/deploy-run.ts` — locate the source `bun-apps/s2-agent` dir (`PI_AGENT_DIR`
  env or upward walk), path-guard `outDir`, spawn helper with timeout + log file.
- `src/deploy-tool.ts` / `src/verify-tool.ts` — run + parse each script's output
  into a structured result (the deploy/verify logic; scripts stay the source of
  truth, no deploy logic duplicated).

## Invariants
- The branch/merge/CI recipes are tested end to end with scripted fakes; no I/O
  in the pure decision modules.
- For deploy_pi_agent_sh/verify_pi_agent_deploy: `deploy.ts` and `run-test.sh` are the single source of
  truth — no deploy logic is duplicated. Scripts exist only in the **source
  repo**; the tools resolve that dir and refuse to spawn if unreachable (never a
  wrong-cwd spawn). Set `PI_AGENT_DIR` to override. No top-level `cd`; spawn uses
  `cwd: <absolute s2-agent dir>`.
- Dynamic + tool-gated (the PR/merge tools via their own keywords; deploy_pi_agent_sh /
  verify_pi_agent_deploy via build/deploy/verify/bundle keywords + noun∧verb requires);
  `show_pr_status` is the lone ungated companion.
