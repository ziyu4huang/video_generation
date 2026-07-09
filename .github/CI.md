# CI

The PR gate. Every pull request to `main` (and every push to `main`) runs
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml), which turns the
manual-`bun test` trust model into an enforced gate.

## Branch protection — the 19 required checks on `main`

`main` is under branch protection: the **19 checks** below are **required**
(strict — no stale checks; branches must be up-to-date) before any merge,
including the admin's (`enforce_admins`). A PR with a failing check is BLOCKED
(merge button disabled); a green PR is mergeable. Applied via `gh api` (a repo
setting, not a committed file) — **if a check is renamed in `ci.yml`, update the
protection rule too** so it stays required:

```bash
# re-assert the 19 required checks on main (run after any check-rename)
gh api -X PUT repos/ziyu4huang/video_generation/branches/main/protection \
  --input - <<'JSON'
{ "required_status_checks": { "strict": true, "contexts": [
  "test · pi-agent", "test · pi-agent-cli", "test · pi-agent-ext-flux2",
  "test · pi-agent-ext-krea2", "test · pi-agent-ext-ltx",
  "test · pi-agent-ext-movie-director", "test · pi-agent-ext-power-tool",
  "test · pi-agent-ext-web-access", "test · pi-agent-sdk-demo", "test · pi-vlm",
  "test · gui-movie-director", "test · pi-knowledge-card", "test · pi-obsidian",
  "test · pi-schema-cost", "test · pi-dynamic-workflows", "test · pi-hermes-memory",
  "extension-contract", "deploy --verify", "regression gates"
] } } /* …preserve existing review/admin settings in the full PUT body… */
JSON
```

> The full PUT replaces the entire protection rule — include the existing
> `enforce_admins`, `required_pull_request_reviews`, and other settings (see
> `gh api repos/ziyu4huang/video_generation/branches/main/protection`).

## What runs on every PR

| Job | What it gates | Fail behavior |
|-----|---------------|---------------|
| **test · `<package>`** (matrix of 16) | Each `bun-apps/*` package's test suite | **blocks** |
| **extension-contract** | The 5 extension-protocol tests (factory loads, wires up, no conflicts, valid schema, handler present) — a named, visible check, not buried in the pi-agent run | **blocks** |
| **deploy --verify** | Builds pi-agent, bundles the 9 extensions, boots the deployed artifact from a foreign cwd, probes `getAllTools` for 0 conflicts | **blocks** |
| **regression gates** | 2 MB file-size guard (twin of `.githooks/pre-commit`) **+** schema-cost regression (warns >5%) **+** test-portability audit (warn-only v1 — surfaces new ungated machine-coupled tests; see [TEST-PORTABILITY.md](TEST-PORTABILITY.md)) | file-size **blocks**; schema-cost + portability **warn only** |

The test matrix gives a **native per-package check row** in the PR UI — a broken
package goes red by name. `fail-fast: false` so every package reports even when
one fails.

### CI-specific setup steps (non-obvious)

Two setup quirks the workflow handles, documented so they aren't "lost":

- **Build `pi-dynamic-workflows` before tests.** Its `main`/`exports` point at
  compiled `dist/index.js` — a gitignored artifact. Importers (`pi-agent-cli` →
  `workflow.ts`, and anything loading the CLI, incl. the schema-cost command)
  resolve that `dist/`. A fresh checkout lacks it (locally it lingers from prior
  builds), so every job runs `bun run --cwd bun-apps/pi-dynamic-workflows build`
  after install (~2.5 s). The documented "builds first" workspace pattern.
- **Install `ffmpeg` for `pi-agent-ext-movie-director`.** Its `preflight` test
  probes ffmpeg on PATH (the composition runtime). `ubuntu-latest` doesn't ship
  it, so the workflow installs it for that matrix entry only. (`compose.test.ts`
  uses mocked ffmpeg; `e2e.local` is opt-in.)

## What is tested

The 16 `bun-apps/*` packages that declare a `test` script, each via its
documented command (see the `tests` matrix in the workflow):

```
pi-agent, pi-agent-cli, pi-agent-ext-flux2, pi-agent-ext-krea2,
pi-agent-ext-ltx, pi-agent-ext-movie-director, pi-agent-ext-power-tool,
pi-agent-ext-web-access, pi-agent-sdk-demo, pi-vlm, gui-movie-director,
pi-knowledge-card, pi-obsidian, pi-schema-cost, pi-dynamic-workflows,
pi-hermes-memory
```

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

- **pi-obsidian** · `baseline.test.mjs` "A0.9 regression baseline" uses
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
- **3 packages with no test script** — `pi-agent-flux2`, `scripts`, `zai-mcp`.
  They have no `bun test` entry point, so they're not in the matrix.
- **pi-dynamic-workflows biome lint** — the package's `test` script chains
  `npm run check` (biome), which has pre-existing formatting drift. CI runs the
  CLAUDE.md canonical command `bun run build && bun test` instead (build +
  unit tests are the gate; the lint drift is a separate cleanup, out of scope for
  the CI cycle).
- **Scheduled/nightly runs, coverage reporting, cross-repo CI** — follow-ups.

## Test-author portability guide

CI runs on `ubuntu-latest` (x86_64, no Apple Silicon). A test that passes on a
fully-set-up dev machine can fail on CI for one of four "works on my machine"
reasons. The [test-portability audit](TEST-PORTABILITY.md) catalogs every
existing instance; this is the cheat-sheet for writing CI-safe tests going
forward.

| If your test… | …it will fail on CI because | Fix pattern |
|---------------|----------------------------|-------------|
| imports a workspace package whose `main`/`exports` point at compiled `dist/` (only `pi-dynamic-workflows` today) | the `dist/` lingers locally from prior builds but is absent on a fresh checkout | ensure the CI build step covers it (the workflow already runs `bun run --cwd bun-apps/pi-dynamic-workflows build` in every job); if you add a new compiled-`dist` workspace dep, add a build step for it |
| spawns/probes a non-bun binary (`ffmpeg`, `ffprobe`, a swift binary, `run.py`, the MLX venv) | the binary/path exists on your machine but not on the runner | `*.skipIf(process.env.CI)`, or gate behind an env-var opt-in (`MLX_E2E`/`PI_AGENT_E2E`/`PI_RUN_L2`); or install the binary in CI (as ffmpeg is) |
| asserts an env var is **unset** while a sibling `beforeEach`/`withEnv` in the same `describe` **sets** it | the env-isolation differs (a `CONFIG_PRESENT` skip can hide the case locally) | clear the var **in-body** before the "unset" assertion (the `testWithoutEnv` helper in `adapter-availability.test.ts`) |
| re-reads `process.env.X` across an `await` that mutates it (the `resolveVault`/`OB_VAULT` pattern) | async timing differs locally; a mid-async re-read picks up a stale/changed value | use a deterministic injection seam (`__setVaultResolverForTest`) or set the env **once** in `beforeAll` and rely on the module's closure cache |

**Rules of thumb:**

- If your test needs the local generation stack (python/venv, built swift
  binaries, `run.py`, the vault submodule), gate it with `*.skipIf(process.env.CI)`
  or an env-var opt-in — never let it run unguarded on the runner.
- If your test reads/writes `process.env`, always save + restore (and clear
  **in-body** before any "unset" assertion).
- Run the audit locally before pushing: `bash scripts/test-portability-audit.sh`.
  A new `existsSync(machine-path)` or `Bun.spawn` in a test file with no
  `CI`/env-var guard prints as `[BLOCK under --strict]` — fix it before the
  check flips from warn-only to blocking.

## Re-running locally

CI uses `CI=true` to trigger the machine-coupled skips. To reproduce the CI
run exactly:

```bash
bun install --frozen-lockfile

# any package, CI semantics (machine-coupled tests skip):
( cd bun-apps/<package> && CI=true bun test )

# the full suite, mirroring the matrix:
for pkg in pi-agent pi-agent-cli pi-agent-ext-flux2 pi-agent-ext-krea2 \
           pi-agent-ext-ltx pi-agent-ext-movie-director pi-agent-ext-power-tool \
           pi-agent-ext-web-access pi-agent-sdk-demo pi-vlm gui-movie-director \
           pi-knowledge-card pi-obsidian pi-schema-cost pi-dynamic-workflows \
           pi-hermes-memory; do
  echo "=== $pkg ==="
  ( cd "bun-apps/$pkg" && CI=true bun test ) || echo "FAILED: $pkg"
done

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
bun bun-apps/pi-agent-cli/src/cli.ts tools-metrics --schema-cost --json \
  > scripts/schema-cost-baseline.json
```

## Bypassing the local hook

The pre-commit hook (`.githooks/pre-commit`) rejects files > 2 MB but is bypassable
with `git commit --no-verify`. The CI file-size guard is the remote twin — it
catches a bypassed local hook so a large blob can't land via PR.
