# Test Portability Audit

> The mechanical, reproducible companion to [CI.md](CI.md). Where CI.md documents
> *what* runs vs. is deferred, this file catalogs *every* test that touches a
> "works on my machine" failure class — and the disposition of each.
>
> **Audit script:** [`scripts/test-portability-audit.sh`](../scripts/test-portability-audit.sh)
> greps the four signal patterns below and prints file:line hits classified
> `GUARDED` / `UNGATED`. Re-running it reproduces this catalog mechanically —
> it is not "someone read all the tests," it is a repeatable scan.

## Why this exists

CI (#381) went red on its first `ubuntu-latest` run, exposing 4 latent bugs that
local `bun test` had masked (the dev machine is fully set up: Apple Silicon, MLX
venv, built swift binaries, ffmpeg, a real vault submodule). Each was a "works on
my machine" failure. The 4 bugs were fixed *reactively*; this audit finds the
rest *proactively* — and the script + this catalog lock the class in so the next
PR can't quietly land a 5th.

### The four failure classes (and the proven fix pattern for each)

| class | signal | why local masked it | fix pattern (proven in #381) |
|-------|--------|---------------------|------------------------------|
| **unbuilt workspace dep** | importer resolves a compiled `dist/` that lingers locally | `dist/` survives from prior builds | build the dep in CI before importers run (`bun run --cwd <pkg> build`) |
| **host-binary probe** | test spawns/probes `ffmpeg`/`ffprobe`/a swift binary | binary installed locally | `*.skipIf(process.env.CI)`, or env-var opt-in; or install the binary in CI |
| **env-isolation flaw** | `beforeEach`/`withEnv` sets an env var; a sibling test asserts it unset | a `CONFIG_PRESENT` skip hid the case locally | clear the var **in-body** before the "unset" assertion (`testWithoutEnv`) |
| **stale / mid-async env read** | `process.env.X` re-read across an `await` that mutated it | async timing differed locally | deterministic injection seam (`__setVaultResolverForTest`) or a captured value |

## How to run the audit

```bash
bash scripts/test-portability-audit.sh            # report (warn-only; exit 0)
bash scripts/test-portability-audit.sh --strict   # exit 1 on any UNGATED P1/P2 hit
```

The script scans `bun-apps/**/*.{test.ts,test.mjs}` (excluding `node_modules`
and `dist`) for four patterns and classifies each hit by whether the file uses a
guard signal (`process.env.CI` / `.skipIf(` / an env-var opt-in /
`testWithoutEnv` / `__setVaultResolverForTest` / `process.execPath` /
`PORTABILITY-GUARDED`).

> **`PORTABILITY-GUARDED`** — sanctioned self-attestation: a
> `// PORTABILITY-GUARDED: <reason>` comment asserts the spawn / path access is
> CI-safe (e.g. spawning `bash` to run a committed repo script, present on every
> runner). Use only when a test MUST run in CI but legitimately touches a host
> binary the skipIf / opt-in signals can't express (the audit's own regression
> test is the canonical case).

- **P1 / P2 block under `--strict`** — `existsSync` of a machine-coupled path
  and `Bun.spawn`/`spawnSync`/`execSync` are reliably machine-coupled; an
  ungated hit is almost always a bug.
- **P3 / P4 are review-only** — env-isolation and mid-async-read flaws need
  structural analysis a line-grep can't do without prohibitive false positives.
  This catalog is the human-reviewed disposition for them; the script surfaces
  them for review but never blocks.

> **Config-mutating env vars (#938 class).** The harness injects
> `PI_HERMES_CONSOLIDATING` / `TOOL_GATE_LOG_PATH` into a live session, flipping
> `loadConfig` defaults — so a test that asserts on config defaults passes in
> CI's clean env but flakes locally. Not block-detectable (P3-class false
> positives). Proven fix: `beforeEach` snapshot+delete+restore. Repo-level tests
> use `bun-apps/tests/helpers/hermetic-env.ts` (`clearHarnessEnvVars` /
> `restoreHarnessEnvVars`); package tests inline the same pattern (their
> `rootDir: src` forbids the cross-package import).

## Audit result (2026-07-09, post-#381 + this cycle)

Scanned **260** test files. Every finding has a disposition — none ambiguous.

### P1 — `existsSync` of a machine-coupled path — **0 hits**

No test directly `existsSync`s `python/venv`, `swift/`, `run.py`, `mlx-models`,
or `video_generation__models`. (The `bridge.test.ts` probe tests call
`probeConfigured()` — a *function* whose internal `existsSync` lives in `src/`,
not the test — and are themselves `skipIf(CI)`-guarded; see P2.) **Class closed.**

### P2 — `Bun.spawn` / `spawnSync` / `execSync` — **17 hits, all `skip-guarded`**

Every host-binary spawn is in a file gated by `process.env.CI` or an env-var
opt-in. None runs ungated on a bare runner.

| file | guard | disposition |
|------|-------|-------------|
| `gui-movie-director/scripts/check-runtime.test.ts` | `describe.skipIf(process.env.CI)` | **skip-guarded** (CI) — spawns `run.py` via the MLX venv |
| `s2-agent-ext-movie-director/src/e2e.local.smoke.test.ts` | `describe.skipIf(!E2E)`, `E2E = MLX_E2E === "1"` | **skip-guarded** (opt-in) — probes `ffprobe` + the full local stack |
| `s2-agent-ext-power-tool/src/__tests__/l2-e2e.test.ts` | `PI_RUN_L2 === "1"` + preflight (LM Studio / vault-mind reachability) | **skip-guarded** (opt-in) — spawns the real CLI per tool |
| `s2-agent/src/__tests__/e2e-extensions.test.ts` | `describe.skipIf(!E2E_ENABLED \|\| !DEPLOY_ENABLED)`, `PI_AGENT_E2E` | **skip-guarded** (opt-in) — deploys + spawns the bundled artifact |
| `s2-agent/src/__tests__/e2e-readonly.test.ts` | `describe.skipIf(SKIPPED)`, `PI_AGENT_E2E` + `PI_AGENT_E2E_DEPLOY` | **skip-guarded** (opt-in) — deploy + `find`/`chmod` probes |
| `s2-agent/src/__tests__/e2e-image-agent.test.ts` | `IMAGE_E2E_ENABLED = truthy(PI_AGENT_E2E_IMAGE)` | **skip-guarded** (opt-in) — spawns the image-agent launcher |

> `s2-agent-ext-movie-director`'s `preflight` test probes `ffmpeg` on PATH; CI
> installs ffmpeg for that matrix entry (see `ci.yml`). `compose.test.ts` uses
> mocked ffmpeg; `e2e.local` is opt-in. **Class closed.**

### P3 — `process.env.*_API_KEY` / `_TOKEN` — **13 hits, all `fixed`**

| file | pattern | disposition |
|------|---------|-------------|
| `s2-agent-ext-web-access/__tests__/adapter-availability.test.ts` | `testWithoutEnv` clears **all** provider keys in-body before the "unavailable" assertion; `CONFIG_PRESENT` skip when a real config exists | **fixed** — the #381 env-isolation fix (in-body clear) |
| `s2-agent-ext-web-access/__tests__/zai.test.ts` | `beforeEach` sets `ZAI_API_KEY`; the "unavailable" assertion does `delete process.env.ZAI_API_KEY` **in-body** before asserting; `afterEach` restores | **fixed** — in-body clear pattern (portable unit test; flagged UNGATED by the script only because it needs no CI/env gate, which is correct) |
| `s2-agent-ext-ultracode/tests/usage-limit-integration.test.ts` | helper sets `DEEPSEEK_API_KEY` to a **faux dummy** for a registered faux provider; `try/finally` restores — never asserts "key unset" | **fixed** — save/restore + faux provider (portable; no real key, no unset assertion) |

### P4 — `process.env.OB_VAULT_*` — **42 hits, all `fixed`**

| file(s) | pattern | disposition |
|---------|---------|-------------|
| `pi-knowledge-card/__tests__/pi-knowledge-card.test.ts` | `__setVaultResolverForTest(() => Promise.resolve(vault))` — deterministic injection seam; also save/restore `OB_VAULT_PATH` | **fixed** — the #381 stale-read fix (injection seam) |
| `pi-obsidian/extensions/__tests__/{expectedMtime,deleteTool,readTool,createGuard,errorCodes,toolSmoke}.test.mjs` | `beforeAll`/`beforeEach` sets `OB_VAULT_PATH` to a fixture **once**; `getVault` caches the resolved vault in a closure (no mid-async re-read); `afterAll`/`afterEach` restores | **fixed** — set-once + closure cache (avoids the mid-async re-read by construction) |
| `pi-hermes-memory/tests/{integration/passive-converge,integration/knowledge-pipeline,store/vault-converge}.test.ts` | `beforeEach` sets `OB_VAULT_PATH` to a tmp vault; `afterEach` restores — no sibling "unset" assertion | **fixed** — save/restore (portable; tmp vault fixture) |
| `s2-agent/src/cli/__tests__/zk-extract.test.ts` | sets `OB_VAULT_PATH`/`OB_VAULT_DIR` in-body to fixtures; tests `resolveVault` directly with parsed args | **fixed** — in-body set to fixture (pure resolution test) |
| `s2-agent/src/cli/__tests__/passthrough.test.ts` | asserts env flags pass through to the parsed config; save/restore around the "preexisting" case | **fixed** — pure parsing assertions (no vault resolution mid-async) |

## Thrust B — the four classes, retired

1. **Unbuilt workspace dep.** `s2-agent-ext-ultracode` is the **only** workspace
   package whose `main`/`exports` point at compiled `dist/` (verified: every
   other `bun-apps/*` package's `main`/`exports` resolve TypeScript `src/`
   directly via Bun). Its sole importers at test time are
   `s2-agent/src/cli/commands/workflow.ts` and
   `s2-agent/run-dir/workflows/verify-bun-s2-agent-cli.js`. The **fresh-clone
   probe** confirms the class is contained: `rm -rf bun-apps/*/dist` → the 4
   `s2-agent` CLI workflow tests fail with `Cannot find module
   '@quintinshaw/pi-dynamic-workflows'`; re-running the CI build step
   (`bun run --cwd bun-apps/s2-agent-ext-ultracode build`) → all 248 pass. CI
   builds it in **every** job (see `ci.yml`). **No other unbuilt-dep surprises.**
2. **Host-binary probe.** All 17 spawn/exec hits are `skip-guarded` (P2 table).
   `ffmpeg` is CI-installed for the one matrix entry that probes it. **None
   ungated.**
3. **Env-isolation flaw.** The `testWithoutEnv` bug is fixed; `zai.test.ts` uses
   in-body clear; `usage-limit` uses save/restore + faux. No describe both sets
   a provider key **and** asserts it unset without an in-body clear. **None
   remaining.**
4. **Stale / mid-async env read.** `pi-knowledge-card` uses the
   `__setVaultResolverForTest` seam; every `OB_VAULT` test uses set-once + cache
   or save/restore with no mid-async re-read. **None remaining.**

## Finding beyond the four classes — vault-submodule baseline drift (`fixed`)

The audit surfaced a 5th, adjacent concern (NOT one of the four classes — it
is submodule-dependence, not machine-coupling, so the script's P1–P4 patterns
don't cover it; noted here per the cycle's "a 5th class → note, don't expand"
guidance). `pi-obsidian/extensions/__tests__/baseline.test.mjs` re-runs the
9-case search against the REAL vault submodule and diffs byte-for-byte against
`fixtures/search-baseline.txt`. It is correctly `describe.skipIf(!vaultAvailable())`-
guarded (skips on CI where the submodule is absent). **But** the submodule
pointer was bumped in #378 (new hermes knowledge cards) without regenerating the
baseline (last refreshed #364), so the test was **red on every dev machine with
the submodule initialized** while staying green on CI via the skip — the mirror
image of a "works on my machine" failure (a dishonest CI green).

**Disposition: `fixed`.** Regenerated `search-baseline.txt` via
`bun run --cwd bun-apps/s2-agent-ext-obsidian regen:baseline`. The diff is data-only (2 new
cards inserted + line-number shifts; search *behavior* unchanged). The skipIf
guard itself is correct and untouched. Local matrix now 16/16 green.

> Follow-up (out of scope, determinism cycle): the `regen:baseline` step should
> run automatically when the `vaults_root/s2-agent-vault` submodule pointer
> changes, so a bump can't silently stale the baseline again.

## Prevention (Thrust C)

The audit script runs in CI as a **warn-only** `regression-gates` step (no
`--strict`) — the report is visible on every PR without blocking. A new
ungated `existsSync(machine-path)` or `Bun.spawn` in a test file prints as
`[BLOCK under --strict]` so it is noticed. Flip the CI step to `--strict` once
the false-positive rate is confirmed ≈ 0 across a few PRs (the documented
capstone). See [CI.md § Test-author portability guide](CI.md#test-author-portability-guide)
for the four classes + fix patterns.
