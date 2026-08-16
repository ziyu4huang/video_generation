# CI

The PR gate. Every pull request to `main` (and every push to `main`) runs
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml), which turns the
manual-`bun test` trust model into an enforced gate.

## Branch protection — the 30 required checks on `main`

> **STATUS (2026-08-12): NOT CURRENTLY APPLIED — this section is the recipe, not
> the live state.** GitHub Actions is disabled here (`.github/workflows/` holds
> only `ci.yml.disabled`, so no check ever reports), and `main` carries no
> protection rule at all — `gh api repos/ziyu4huang/video_generation/branches/main/protection`
> returns 404. Everything below describes what to re-apply if CI is turned back
> on. Until then the gates are a **soft** constraint: run the suites locally.
> Verify before assuming, rather than inferring the live state from this file.

When applied, `main` is under branch protection: the **30 checks** below are **required**
(the 28 `test · <package>` matrix rows + `extension-contract` + `regression gates`)
(strict — no stale checks; branches must be up-to-date) before any merge,
including the admin's (`enforce_admins`). A PR with a failing check is BLOCKED
(merge button disabled); a green PR is mergeable. Applied via `gh api` (a repo
setting, not a committed file) — **if a check is renamed in `ci.yml`, update the
protection rule too** so it stays required:

```bash
# re-assert the 30 required checks on main (run after any check-rename)
# = every `package:` in ci.yml's `tests` matrix, prefixed "test · ", plus the
#   two always-run named jobs. Regenerate rather than hand-edit:
#     bash scripts/ci-local.sh --list
gh api -X PUT repos/ziyu4huang/video_generation/branches/main/protection \
  --input - <<'JSON'
{ "required_status_checks": { "strict": true, "contexts": [
  "test · pi-agent", "test · pi-agent-ext-flux2",
  "test · pi-agent-ext-krea2", "test · pi-agent-ext-ltx",
  "test · pi-agent-ext-movie-director", "test · pi-agent-ext-power-tool",
  "test · pi-agent-ext-web-access", "test · gui-movie-director",
  "extension-contract", "regression gates",
  "test · pi-agent-ext-knowledge-card", "test · pi-agent-ext-hermes-memory",
  "test · pi-agent-ext-workflow",
  "test · pi-agent-ext-btw", "test · pi-agent-ext-task",
  "test · pi-agent-ext-file2md", "test · pi-agent-ext-obsidian",
  "test · pi-agent-ext-research-tool",
  "test · pi-agent-ext-zai-mcp", "test · pi-agent-ext-wayfind", "test · pi-agent-ext-archify",
  "test · perf-harness",
  "test · pi-agent-ext-tool-gate", "test · pi-agent-ext-superpowers",
  "test · pi-agent-ext-subagent",
  "test · pi-agent-core-interface", "test · pi-agent-core-runtime",
  "test · pi-agent-ext-devops", "test · pi-agent-ext-prompt-history",
  "test · pi-agent-ext-webui"
] } } /* …preserve existing review/admin settings in the full PUT body… */
JSON
```

> The last 8 contexts above were absent from earlier revisions of this recipe
> even though 3 of them (`tool-gate`, `superpowers`, `subagent`) were already
> matrix rows — the list was hand-maintained and drifted. `test · pi-agent-ext-picker`
> was also listed in the matrix for a package directory that does not exist; that
> row is gone. Re-derive from `bash scripts/ci-local.sh --list` after any matrix
> edit instead of appending by hand.

> The full PUT replaces the entire protection rule — include the existing
> `enforce_admins`, `required_pull_request_reviews`, and other settings (see
> `gh api repos/ziyu4huang/video_generation/branches/main/protection`).
>
> **`deploy --verify` and `changed packages` are intentionally NOT required.**
> `deploy --verify` is path-gated (`check-deploy-paths`) and only runs on PRs
> touching `bun-apps/pi-agent/` — a job that doesn't run on most PRs can't be a
> required check (it would permanently block them as "expected but never
> reported"). `changed packages` doesn't need to be required either: the `tests`
> job already fails open on its failure (runs every package rather than
> skipping — see "Smart test routing" above), so the safety net lives in the
> required `test · <package>` checks themselves, not in a separate gate.
>
> The `determinism spot-check` job is intentionally NOT in the required 30 — it
> is v1 informational (`continue-on-error`): it runs the flake-prone subset 3×
> and surfaces flakes without blocking. Promote it to required once the
> false-positive rate is ≈ 0 (the same rollout the portability audit just
> completed: warn → block).

## What runs on every PR

| Job | What it gates | Fail behavior |
|-----|---------------|---------------|
| **changed packages** | Computes which `bun-apps/*` packages the `test` matrix actually needs to run, from the changed-file set (see "Smart test routing" below) | **blocks** (its own failure fails OPEN — see below, not a silent skip) |
| **test · `<package>`** (matrix of 28) | Each `bun-apps/*` package's test suite — one row per workspace package, i.e. complete coverage. Only the packages `changed packages` marks affected actually execute on a PR; push-to-main always runs all 28 | **blocks** |
| **extension-contract** | The 5 extension-protocol tests (factory loads, wires up, no conflicts, valid schema, handler present) — a named, visible check, not buried in the pi-agent run | **blocks** |
| **deploy --verify** | Builds pi-agent, bundles the 9 extensions, boots the deployed artifact from a foreign cwd, probes `getAllTools` for 0 conflicts | **blocks** |
| **regression gates** | 13 steps. Blocking: 2 MB file-size guard (twin of `.githooks/pre-commit`), lockfile duplicate-version guard (the `@earendil-works/*` family must resolve to one version workspace-wide), dep-direction (ADR-monorepo-0001), cross-extension seam contract, cross-extension routing contract, config-field parity, package-script runnability, CI-workflow references, the portability-audit regression test, PR-finish decision tests (now `bun-apps/pi-agent-ext-devops/tests/pr-finish-cli.test.ts`, the `devops-pr-finish` bin), and the test-portability audit — now `--strict`, see [TEST-PORTABILITY.md](TEST-PORTABILITY.md). Warn-only: schema-cost (>5%) and the test-determinism audit. Enumerate the live list with `bash scripts/ci-local.sh --gates --list`; `.githooks/pre-push` runs the whole job. | all **block** except schema-cost + determinism-audit (**warn only**) |

The test matrix gives a **native per-package check row** in the PR UI — a broken
package goes red by name. `fail-fast: false` so every package reports even when
one fails.

### Smart test routing (changed_packages)

A PR that only touches `bun-apps/pi-agent-ext-power-tool/` shouldn't pay for all
28 matrix entries. The `changed_packages` job computes, per PR, which packages
are actually affected.

**Where the code lives (the former `scripts/ci-changed-packages.sh`).** The bash
script was ported to
`bun-apps/pi-agent-ext-devops/src/changed-packages.ts` (`computeChangedPackages`)
so the devops `local_ci` tool and remote CI share ONE implementation, and the
bash was deleted. `src/changed-packages-cli.ts` is the thin bash-callable wrapper
the workflow invokes — same argv contract the script had, same single-line JSON
on stdout:

```bash
bun bun-apps/pi-agent-ext-devops/src/changed-packages-cli.ts --all
bun bun-apps/pi-agent-ext-devops/src/changed-packages-cli.ts <baseSha> <headSha>
```

It is a plain script entry, **not** an `extensions/cli-subcommand.ts` (that
convention is for agent-driven `pi-agent cli <x>` sub-commands, which need the
host + an installed workspace). The wrapper imports only node builtins plus the
package's own spawn seam, so the `changed_packages` job runs on a bare checkout
with `oven-sh/setup-bun` alone — no `setup-env`, no `bun install` — and stays a
seconds-long pre-flight for the 28-row matrix behind it.

The algorithm, unchanged from the retired script:

1. Reads every `bun-apps/*/package.json`'s `@repo/*` dependencies **live**
   (grep, not a hand-maintained table) to build the workspace dependency graph.
2. Diffs the PR's base...head file list.
3. A change confined to `bun-apps/<pkg>/` marks `<pkg>` **and every package that
   transitively depends on it** (reverse-BFS — e.g. touching
   `pi-agent-ext-file2md` also marks `pi-agent-ext-flux2` and, through it,
   `pi-agent-ext-movie-director`).
4. **Fails OPEN**: any changed file outside a known `bun-apps/<pkg>/` path (root
   config, `.github/`, `scripts/`, …) marks **every** package true — this script
   has no way to know which package a shared-config change might affect, so it
   doesn't guess.
5. `push` events (post-merge on `main`) always run every package unconditionally
   — same precedent as `deploy --verify`'s `check-deploy-paths` gate below.

The gate lives on the `tests` job's **steps** (checkout, `setup-env`, ffmpeg
install, the actual test run), not the job itself — `matrix` context isn't
available in a job-level `if:` (only `github`/`needs`/`vars`/`inputs` are;
`actionlint` catches this, a plain YAML parser doesn't, since the file stays
syntactically valid YAML and only GitHub's own expression-schema check rejects
it — at push/PR time, with **zero check-runs created** and no useful error
surfaced via the API). Every `test · <package>` job instance — and its check —
still always exists and reports for every PR; unaffected packages just no-op
through skipped steps and the job reports success in seconds. Run
`actionlint .github/workflows/ci.yml` after editing this file — a clean local
`python3 -c "import yaml; yaml.safe_load(...)"` is NOT sufficient to catch
this class of error.

The condition also fails open if `changed_packages` itself **fails** (script
bug, unresolvable diff range, …): rather than the default GitHub Actions
behavior of silently *skipping* every dependent job (which would read as
green/passing on the PR while never running a single test), every step still
runs.

Tests: `( cd bun-apps/pi-agent-ext-devops && bun test tests/changed-packages.test.ts
tests/changed-packages-cli.test.ts )` — direct unit tests of
`computeChangedPackages` and of the CLI wrapper's argv/stdout contract, with the
`spawn` / `discoverPackages` / `readDeps` seams injected (no real git repo). The
old `scripts/ci-changed-packages.test.ts` went with the bash script.

### CI-specific setup steps (non-obvious)

Two setup quirks the workflow handles, documented so they aren't "lost":

- **Build `pi-agent-ext-workflow` before tests.** Its `main`/`exports` point at
  compiled `dist/index.js` — a gitignored artifact. Importers (`pi-agent` →
  `workflow.ts`, and anything loading the CLI, incl. the schema-cost command)
  resolve that `dist/`. A fresh checkout lacks it (locally it lingers from prior
  builds), so every job runs `bun run --cwd bun-apps/pi-agent-ext-workflow build`
  after install (~2.5 s). The documented "builds first" workspace pattern.
- **Install `ffmpeg` for `pi-agent-ext-movie-director`.** Its `preflight` test
  probes ffmpeg on PATH (the composition runtime). `ubuntu-latest` doesn't ship
  it, so the workflow installs it for that matrix entry only. (`compose.test.ts`
  uses mocked ffmpeg; `e2e.local` is opt-in.)
- **Build `pi-agent-ext-webui` before its tests.** Second package whose `main`
  points at a gitignored compiled `dist/index.js`; its matrix row is spelled
  `bun run build && bun run test:unit` for that reason.

## What is tested

**28** `bun-apps/*` packages — **one matrix row per workspace package**, i.e. every
package in the workspace is covered. Each runs via its documented command (see
the `tests` matrix in the workflow; whether it actually RUNS on a given PR
depends on `changed_packages` — see "Smart test routing" above):

```
pi-agent, pi-agent-ext-flux2, pi-agent-ext-krea2,
pi-agent-ext-ltx, pi-agent-ext-movie-director, pi-agent-ext-power-tool,
pi-agent-ext-btw, pi-agent-ext-task, pi-agent-ext-archify,
pi-agent-ext-web-access, pi-agent-ext-file2md, gui-movie-director,
pi-agent-ext-knowledge-card, pi-agent-ext-obsidian,
pi-agent-ext-workflow, pi-agent-ext-hermes-memory,
pi-agent-ext-research-tool, pi-agent-ext-zai-mcp,
pi-agent-ext-wayfind, perf-harness,
pi-agent-ext-tool-gate, pi-agent-ext-superpowers, pi-agent-ext-subagent,
pi-agent-core-interface, pi-agent-core-runtime,
pi-agent-ext-devops, pi-agent-ext-prompt-history, pi-agent-ext-webui
```

Prefer `bash scripts/ci-local.sh --list` over this block: it prints the same set
parsed straight out of `ci.yml.disabled`, so it cannot drift.

**Added 2026-08-12 — 52 test files that had never run in CI:**

| package | test files | matrix command | why it was missed |
|---|---|---|---|
| `pi-agent-ext-webui` | 21 | `bun run build && bun run test:unit` | compiled-`dist` package; largest uncovered suite in the repo |
| `pi-agent-ext-devops` | 17 | `bun test` | owns the CI change-detection port — CI's own routing logic was untested by CI |
| `pi-agent-core-runtime` | 10 | `bun test` | extracted from `pi-agent-ext-subagent` in #1251; a NEW package is invisible to a hand-listed matrix, so its 10 files left CI at extraction time |
| `pi-agent-core-interface` | 2 | `bun test` | seam-contract package; only the static guard in `regression gates` touched the seam, never these tests |
| `pi-agent-ext-prompt-history` | 2 | `bun test` | statically bundled into the compiled binary (see `compile-verify`), so a break ships into the exe |

**Removed 2026-08-12:** `test · pi-agent-ext-picker` — `bun-apps/pi-agent-ext-picker/`
does not exist. A required check for a deleted package is permanently
"expected but never reported" and would block every PR if protection were on.

`pi-agent-ext-zai-mcp` has **no `test` script** in its `package.json` and is
nonetheless a correct matrix row: `bun test` discovers `*.test.ts` without one
(2 files). Don't "clean it up".

`pi-agent-ext-btw`/`pi-agent-ext-ask-user`/`pi-agent-ext-task` were already
in the `ci.yml` matrix but missing from this list (a doc-drift gap found and
fixed alongside the 5 newly-added packages below).

Later, `pi-agent-ext-ask-user`'s standalone check was retired on 2026-07-18
when the package was merged into `pi-agent-ext-task` (see that package's
`CONTEXT.md`) — its tests now run under `test · pi-agent-ext-task`.

`pi-agent-cli` was merged into `pi-agent` as a `cli` namespace in #1257; its
suites run under `test · pi-agent`.

## What is deliberately NOT tested in CI (and why)

CI runs on **GitHub Actions `ubuntu-latest`** (x86_64, no Apple Silicon). Tests
that probe the local Apple-Silicon generation stack cannot run there. They are
either skipped under `CI=true` (set automatically by GitHub Actions) or excluded
entirely — never silently.

### Skipped under `CI=true` (machine-coupled, gated with `*.skipIf(process.env.CI)`)

These run locally (CI unset) where the stack is present; they skip on the CI
runner:

- **gui-movie-director** · `scripts/check-runtime.test.ts` — spawns `run.py`
  via the MLX venv to validate the argparse contract.
- **pi-agent-ext-ltx** · `runpy.test.ts` ("resolves venv python + run.py") and
  `index.test.ts` ("bare variant name 'baseline'") — the former asserts the
  venv exists on disk; the latter spawns the ltx binary (times out when unbuilt).
- **pi-agent-ext-movie-director** · `bridge.test.ts` (3 tests) — `selectProvider`
  + `probeConfigured` hard-assert the local venv/swift binary presence.

The **portable** tests in those same files (contract parsing, path safety,
registry data, mocked spawns) still run and ARE gated in CI.

### Self-skipping (env-precondition gates, no CI flag needed)

- **pi-agent-ext-obsidian** · `baseline.test.mjs` "A0.9 regression baseline" uses
  `describe.skipIf(!vaultAvailable())` — skips when the
  `vaults_root/pi-agent-vault` submodule is absent (the CI case; the submodule is
  a private repo, not initialized by the default checkout). The CI-enforced
  backward-compat contract lives in `baseline-contract.test.mjs` (frozen vault,
  no submodule dep) and always runs.

### Opt-in e2e / local tests (skip by default via their own env vars)

These never run in CI; they're gated on explicit env vars:

- `pi-agent-ext-movie-director` · `e2e.local.smoke.test.ts` — `MLX_E2E=1`
- `pi-agent` · `e2e-image-agent.test.ts` — `PI_AGENT_E2E_IMAGE=1`
- `pi-agent` · `e2e-extensions.test.ts` / `e2e-readonly.test.ts` — `PI_AGENT_E2E=1` (+ deploy)
- `pi-agent-ext-power-tool` · `l2-e2e.test.ts` — opt-in (spawns the real CLI)

### Out of scope entirely

- **GPU / Metal / MLX tests** — `python/mlx-movie-director` pytest (incl.
  `--run-gpu`). No Apple Silicon on Actions runners; the MLX stack also needs the
  sibling-fork deps (`mflux`, `ltx-2-mlx`) not on PyPI. **Local-only.**
- **`scripts/`** — not a `bun-apps/*` workspace package (no `package.json`), so
  it's outside this matrix by construction. Its own `*.test.ts` files
  (`pr-finish.test.ts`, `drawthings-bench.test.ts`, `multi-hop-eval.test.ts`) run
  directly via `bun test scripts/<file>.test.ts` in the jobs that need them,
  not through the package matrix. (`pr-finish.test.ts` has since moved into
  `bun-apps/pi-agent-ext-devops/tests/pr-finish-cli.test.ts` — the script was
  ported to the `devops-pr-finish` bin.)
  (`pi-agent-ext-zai-mcp` was previously miscategorized here too — it has no
  `package.json` `test` script, but `bun test` doesn't require one to discover
  `*.test.ts` files; it's now correctly in the matrix.)
- **pi-agent-ext-workflow biome lint** — the package's `test` script chains
  `npm run check` (biome), which has pre-existing formatting drift. CI runs the
  CLAUDE.md canonical command `bun run build && bun test` instead (build +
  unit tests are the gate; the lint drift is a separate cleanup, out of scope for
  the CI cycle).

### Known-red rows (2026-08-12) — real, pre-existing, deliberately not papered over

`pi-agent-ext-wayfind` and `pi-agent-ext-subagent` both run the package's
`bun run test` chain (`biome check` → `tsc` build → `bun test`) and both
currently **exit 1 at the biome step**, before a single test runs:

| package | biome | unit tests | first bad commit |
|---|---|---|---|
| `pi-agent-ext-wayfind` | 1 error (`useTemplate`, `src/__tests__/settings.test.ts`) | **536 pass / 0 fail** | #1228 |
| `pi-agent-ext-subagent` | 17 errors (`noUnusedVariables` in `src/subagents-command.ts`; `noNonNullAssertion` in `tests/install-subagent-context-widget.test.ts`) | **481 pass / 0 fail** | #1013 / #1078 |

Both were verified identical at `32c529d2^` (a probe worktree at the merge
parent produced the same failure and the same diagnostic counts), so **neither
is a regression from the pi-agent-cli merge**. The rows are correct as written —
the LINT is what needs fixing. Do not "fix CI" by downgrading these to
`bun run build && bun run test:unit`; that would hide the drift the same way
`pi-agent-ext-workflow`'s carve-out above already does.
- **Scheduled/nightly runs, coverage reporting, cross-repo CI** — follow-ups.

## Test-author portability guide

CI runs on `ubuntu-latest` (x86_64, no Apple Silicon). A test that passes on a
fully-set-up dev machine can fail on CI for one of four "works on my machine"
reasons. The [test-portability audit](TEST-PORTABILITY.md) catalogs every
existing instance; this is the cheat-sheet for writing CI-safe tests going
forward.

| If your test… | …it will fail on CI because | Fix pattern |
|---------------|----------------------------|-------------|
| imports a workspace package whose `main`/`exports` point at compiled `dist/` (only `pi-agent-ext-workflow` today) | the `dist/` lingers locally from prior builds but is absent on a fresh checkout | ensure the CI build step covers it (the workflow already runs `bun run --cwd bun-apps/pi-agent-ext-workflow build` in every job); if you add a new compiled-`dist` workspace dep, add a build step for it |
| spawns/probes a non-bun binary (`ffmpeg`, `ffprobe`, a swift binary, `run.py`, the MLX venv) | the binary/path exists on your machine but not on the runner | `*.skipIf(process.env.CI)`, or gate behind an env-var opt-in (`MLX_E2E`/`PI_AGENT_E2E`/`PI_RUN_L2`); or install the binary in CI (as ffmpeg is) |
| asserts an env var is **unset** while a sibling `beforeEach`/`withEnv` in the same `describe` **sets** it | the env-isolation differs (a `CONFIG_PRESENT` skip can hide the case locally) | clear the var **in-body** before the "unset" assertion (the `testWithoutEnv` helper in `adapter-availability.test.ts`) |
| re-reads `process.env.X` across an `await` that mutates it (the `resolveVault`/`OB_VAULT` pattern) | async timing differs locally; a mid-async re-read picks up a stale/changed value | use a deterministic injection seam (`__setVaultResolverForTest`) or set the env **once** in `beforeAll` and rely on the module's closure cache |

**Rules of thumb:**

- If your test needs the local generation stack (python/venv, built swift
  binaries, `run.py`, the vault submodule), gate it with `*.skipIf(process.env.CI)`
  or an env-var opt-in — never let it run unguarded on the runner.
- If your test reads/writes `process.env`, always save + restore (and clear
  **in-body** before any "unset" assertion).
- Run the audit locally before pushing: `bash scripts/test-portability-audit.sh
  --strict`. It now BLOCKS in CI; a new `existsSync(machine-path)` or
  `Bun.spawn` in a test file with no `CI`/env-var guard will fail the
  `regression gates` check. Fix it (add a guard) before pushing.

## Test-author determinism guide

A test that passes once but fails on re-run is a flake — and now that the gate
is mandatory, a flake blocks PRs on nondeterminism. The
[test-determinism audit](TEST-DETERMINISM.md) catalogs every existing instance;
this is the cheat-sheet for the four cross-RUN failure classes.

| If your test… | …it will flake because | Fix pattern |
|---------------|------------------------|-------------|
| asserts on "X seconds ago" / file freshness / a generated timestamp against the wall-clock | the gap between recording `now` and asserting drifts with clock + test speed | inject a clock seam (`relativeTime(iso, now)` defaults `Date.now()`; tests pass a fixed `now`) or assert on **relative/delta** values — never the wall-clock. A `timestamp: Date.now()` used only as a fixture **seed** (never compared to "now") is fine |
| writes to the real `~/.pi/`, `~/.config`, vault, or model dir | it races with live sessions / self-improve runs writing the same files; a crash mid-test corrupts host state | route through a **tmpdir** (`mkdtempSync` per test), or inject the root via `PI_CODING_AGENT_DIR` / `__setAgentRootForTest` / `__setConfigPathForTest`. Never `homedir()`-derived paths in a portable test |
| relies on cross-file shared state, or stalls when test files run concurrently | synchronous native ops (better-sqlite3) on a shared thread starve another file's async I/O — an intermittent multi-minute stall | use **per-file process isolation** for packages that mix synchronous native ops with async I/O (pi-agent-ext-hermes-memory's `tests/run-all.sh`); close every handle you open (`dbManager.close()` in `afterEach`). A single `bun test` is fine for a quick local check but not for a flake-sensitive gate |
| makes a real `fetch()` / HTTP / DNS call | the service is down / rate-limits / returns different data per run | mock `globalThis.fetch` (the `zai.test.ts` save/restore pattern), mock DNS (`{ lookup: fn }`), or `skipIf` when the service is unreachable (the `semanticSearch` graceful-`isError` pattern). A URL **string** parsed by a pure function is fine |

**Rules of thumb:**

- If your test touches **time, host-state, or network**: inject / mock /
  isolate — never assert against the real world.
- The proven seams are all already in-tree: `relativeTime(iso, now)` (clock),
  `__setAgentRootForTest` / `__setConfigPathForTest` / `mkdtempSync` (host),
  `globalThis.fetch = mock` (network), `dbManager.close()` (handles).
- Run the audit locally before pushing: `bash scripts/test-determinism-audit.sh`.
  D2 (real-host-state writes) blocks under `--strict`; D1/D4 are review-only.
  The `determinism spot-check` job runs the flake-prone subset 3× — if a test
  flakes there, it will flake on real PRs.

> The portability + determinism guides together are the complete "how to write
> a CI-safe test" contract: **portable** (cross-machine, the portability guide)
> + **deterministic** (cross-run, this guide).

## Re-running locally

CI uses `CI=true` to trigger the machine-coupled skips. Since Actions is
currently disabled, this is the ONLY way the matrix gets exercised at all.

**Use `scripts/ci-local.sh`** — it parses the `tests` matrix out of
`ci.yml.disabled` at runtime (it does not carry its own copy of the package
list), so it cannot drift from the workflow:

```bash
bash scripts/ci-local.sh --list                       # print the parsed matrix, run nothing
bash scripts/ci-local.sh                              # run every matrix entry, CI=true
bash scripts/ci-local.sh --only pi-agent-ext-webui    # one (or a comma-separated subset)
bash scripts/ci-local.sh --gates                      # the regression-gates job instead (~6s)
```

It mirrors `fail-fast: false` (continues past failures, exits non-zero if any
failed) and **loudly skips** a matrix package whose directory is missing, so a
future dead row like `pi-agent-ext-picker` is visible rather than silently
passing.

`--gates` runs the `regression-gates` job — every structural guard in the repo
(dep-direction, seam, routing, config-parity, CI-workflow references,
package-script runnability, the portability and determinism audits, PR-finish
decision tests (pi-agent-ext-devops `tests/pr-finish-cli.test.ts`), schema-cost). It is parsed live from the same workflow, so it
carries no copy of the step list either. **`.githooks/pre-push` runs it on every
push**, which is what makes those guards blocking rather than advisory; a
machine whose python3 lacks PyYAML gets a warning and the portability audit
alone rather than a blocked push.

Neither mode covers `extension-contract`, `deploy-verify`, `compile-verify`,
`clean-launch-self-heal`, or `determinism-spotcheck` (run that one via
`bash scripts/test-determinism-spotcheck.sh`). A green run is not a green CI.

By hand, if you need to:

```bash
# The Bun workspace root is bun-apps/ (not the repo root) — install from there:
( cd bun-apps && bun install --frozen-lockfile )

# any package, CI semantics (machine-coupled tests skip):
( cd bun-apps/<package> && CI=true bun test )

# the named checks:
( cd bun-apps/pi-agent && CI=true bun test src/__tests__/extension-contract.test.ts )
( cd bun-apps/pi-agent && CI=true bun scripts/deploy.ts /tmp/ci-verify --writable --verify )
bash scripts/ci-file-size-guard.sh
bun scripts/check-schema-cost.ts
```

Without `CI=true`, the machine-coupled tests run and require the local
generation stack (python/venv, built swift binaries, run.py) — i.e. they run on a
fully-set-up dev machine.

## Updating the schema-cost baseline

The schema-cost regression step compares the live aggregate (`totalTokens`) against
[`scripts/schema-cost-baseline.json`](../scripts/schema-cost-baseline.json). A
**>5% increase prints a warning but does not block** (schema growth is sometimes
intentional — a new tool, a richer description). A deliberate increase should
refresh the baseline in the same PR:

```bash
bun bun-apps/pi-agent/src/cli.ts cli tools-metrics --schema-cost --json \
  > scripts/schema-cost-baseline.json
```

## The local hooks, and bypassing them

Both live in `.githooks/` and are wired by `core.hooksPath`. Run
`bash scripts/setup.sh` once per clone **and once per new worktree** — it sets
the path to the RELATIVE `.githooks`, which is what makes each worktree run its
own hooks. An absolute value there sits in the shared config and silently points
every worktree at one checkout's copy.

| Hook | Runs | Bypass |
|---|---|---|
| `pre-commit` | 2 MB file-size guard | `git commit --no-verify` |
| `pre-push` | the whole `regression-gates` job via `ci-local.sh --gates` (~6s) | `git push --no-verify` |

The CI file-size guard is the remote twin of `pre-commit` — it catches a
bypassed local hook so a large blob can't land via PR.

`pre-push` exists because Actions is disabled: without it the thirteen
structural guards have no executor at all, and a guard nobody runs quietly stops
being true. If `python3` has no PyYAML the workflow cannot be parsed, so the
hook warns and falls back to the test-portability audit alone rather than
blocking the push — install PyYAML for full local coverage.
