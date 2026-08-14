# pi-agent-ext-devops

DevOps tools for the pi coding agent — a **tool-based** PR-merge / branch /
local-CI lifecycle that replaces brittle agent-side bash polling loops. All
`gh`/`git` output is parsed as structured JSON (no `grep -c` footguns); the full
recipes live in tested code (`src/`).

## Tools

### PR / merge / branch / CI tools
- **await_pr_merge** — a LOCAL-CI-GATED merge. Runs `local_ci` (offline
  typecheck+tests+gates over the PR's changed packages vs its base), then
  squash-merges when green + CLEAN. Blocks on red CI / detection error / BEHIND /
  non-CLEAN. No remote CI (disabled in this repo), no polling.
- **pr_status** — one-shot PR snapshot (state + mergeState + check tally). An
  ungated companion (always active).
- **sweep_branches** — classify + (dry-run by default) delete merged
  local/remote branches. Conservative: only `gh`-confirmed MERGED PRs are
  auto-deletable; uncertain cases go to a `review` bucket.
- **local_ci** — OFFLINE local CI: typecheck + tests scoped to changed packages
  vs `origin/main`, plus repo gates. Structured pass/fail; self-verify before
  `gh ship` (await_pr_merge gates on this). A package's test command comes from
  its row in `.github/workflows/ci.yml.disabled` (`src/ci-matrix.ts`), run via
  `bash -c` — so `--isolate`, `&& bun run qa`, and build-first rows are honored
  exactly as remote CI would; only packages with NO matrix row fall back to the
  generic `bun run test`. `scripts/ci-local.sh` parses the same block, so the two
  local runners cannot disagree.
- **changed-packages CLI** (`src/changed-packages-cli.ts`) — the bash-callable
  wrapper the workflow's `changed_packages` job shells out to (`--all`, or
  `<baseRef> <headRef>` → one line of JSON). Deliberately a plain script entry,
  not an `extensions/cli-subcommand.ts`: that job runs before any `bun install`.
- **devops-pr-finish bin** (`src/pr-finish-cli.ts`) — bash-callable PR finish
  (preflight → local-CI gate → merge gates → squash-merge → verify_merge →
  branch cleanup); the TS port of the deleted `scripts/pr-finish.sh`.
- **sync_repo** — sync this worktree/repo to the latest default branch
  (full/rebase/pull; worktree-aware; aborts on divergent unless `force`).
  **Preserves auto-managed hot files**: the default advance aborts `dirty_tree`
  on uncommitted work, EXCEPT preserve-listed paths (default
  `.agents/memory/MEMORY.md` — hermes-managed, dirty in ~every worktree) which
  are stashed before the advance and restored after. Override via `preserve:`;
  `preserve: []` disables it (strict gate). Outcomes carry `preserved?:
  { paths, restored, conflict? }`.
- **devops_retrospect** — advisory post-run anomaly review (never blocks).
- **prepare_branch** — worktree-aware branch prepare (create / rebase /
  force-push-with-lease). Covers the BEHIND state.
- **verify_merge** — post-merge verify (merge state + file scope CLEAN/CONTAMINATED
  + branch-spent).

### Build & verify tools (absorbed from the former `pi-agent-ext-deploy`)
Two thin tools that wrap the existing build/verify/deploy scripts. Each keeps
its OWN owner-declared gating keywords (build/deploy/verify/bundle/dist),
distinct from the PR/merge keywords above.

- **pi_deploy** — build + deploy the pi-agent bundle + thin extension bundles.
  Mirrors `bun-apps/pi-agent/scripts/deploy.ts` (codegen → bundle → ext bundles
  → factory-verify → freeze). Params: `mode` (bundle|snapshot|standalone|exe,
  default bundle), `outDir` (path-guarded to `<repo>/dist/` or `$TMPDIR`),
  `noFreeze`.
- **pi_verify** — run a `run-test.sh` tier (quick|medium|high|readonly|full,
  default medium). `high` = the exact CI `deploy -- verify` job. Params:
  `tier`, `bail`.

## Layout
- `extensions/devops.ts` — registered entry; thin glue registering every tool.
- `src/pr-logic.ts` / `src/branch-logic.ts` — PURE decision logic (unit-tested).
- `src/recipe.ts` / `src/branch-recipe.ts` / `src/ci-recipe.ts` / `src/sync-recipe.ts`
  / `src/retrospect-recipe.ts` / `src/prepare-recipe.ts` / `src/verify-merge-recipe.ts`
  — orchestration, I/O behind injectable clients (tested with fakes).
- `src/gh.ts` — the real `GhClient` / `BranchClient` wrapping the `gh`/`git` CLI;
  pure JSON/text parsers. `BranchClient.dirtyPaths(dir)` lists TRACKED dirty
  paths (repo-relative; excludes untracked/ignored) via `git status --porcelain=v1`;
  `isClean` remains for other recipes. `SyncClient` now `Pick`s `dirtyPaths`
  (not `isClean`) so the per-path preserve split runs on one query.
- `src/deploy-argv.ts` — PURE param→argv mapping for pi_deploy/pi_verify
  (unit-tested, isolated from spawning).
- `src/deploy-run.ts` — locate the source `bun-apps/pi-agent` dir (`PI_AGENT_DIR`
  env or upward walk), path-guard `outDir`, spawn helper with timeout + log file.
- `src/deploy-tool.ts` / `src/verify-tool.ts` — run + parse each script's output
  into a structured result (the deploy/verify logic; scripts stay the source of
  truth, no deploy logic duplicated).

## Invariants
- The branch/merge/CI recipes are tested end to end with scripted fakes; no I/O
  in the pure decision modules.
- For pi_deploy/pi_verify: `deploy.ts` and `run-test.sh` are the single source of
  truth — no deploy logic is duplicated. Scripts exist only in the **source
  repo**; the tools resolve that dir and refuse to spawn if unreachable (never a
  wrong-cwd spawn). Set `PI_AGENT_DIR` to override. No top-level `cd`; spawn uses
  `cwd: <absolute pi-agent dir>`.
- Dynamic + tool-gated (the PR/merge tools via their own keywords; pi_deploy /
  pi_verify via build/deploy/verify/bundle keywords + noun∧verb requires);
  `pr_status` is the lone ungated companion.
