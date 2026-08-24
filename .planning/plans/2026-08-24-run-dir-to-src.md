# run-dir → src/run-dir — the package's code gets one home

Status: done · landed 2026-08-24 (user directive: first priority over the CI-E2E plan)

## Problem

`bun-apps/s2-agent/run-dir/` was the one core-machinery directory parked
outside `src/` — the repo-source resource dir (`resolve.ts` argv splice,
`run-context.ts` layout facts, `registry.ts` `loadRegistry` validation
authority, the derived `manifest.json`, tests, workflows samples). Map D6
("the registry read surface STAYS in run-dir/") kept it there mainly for a
YAML-transitional reason; the YAML bridge is gone (t04, D9) and D4 pins only
`src/registry-config.ts` to zero imports — nothing stops the surface living
under `src/`.

## Change (one PR)

`git mv bun-apps/s2-agent/run-dir bun-apps/s2-agent/src/run-dir` — whole dir,
concept names preserved (patch `load-run-dir-resources`, env
`BUN_PI_LOAD_RUN_DIR`, `[bun-pi] run-dir:` logs, doctor labels, CONTEXT.md
glossary term). Path strings + relative imports rewired:

- **Depth invariant**: the ascent to `bun-apps/` becomes THREE ups
  (`src/run-dir/ → src/ → s2-agent/ → bun-apps/`) — `run-context.ts`,
  `check-deps.ts`, `registry.test.ts`, `registry-freshness.test.ts`,
  `resolve.test.ts`; `single-registry-guard.test.ts` `REPO_ROOT` → four ups.
- **Imports**: moved tree `../src/X` → `../X`; `src/` consumers
  `../run-dir/X` → `./run-dir/X`; `scripts/` → `../src/run-dir/...`; the one
  cross-package import (devops `deploy/lib/config.ts`) + the deploy-e2e
  sensitivity pattern (`ci-deploy-gate.ts`) updated.
- **Pins**: `run.sh` check-deps branch, `tsconfig.json` include (stale
  `run-dir/**` dropped), `.github/workflows/ci.yml.disabled` lockstep with
  `bun-apps/tests/ci-workflow-references.test.ts`.
- **Generated**: `static-extensions-gen.ts` header/banner templates →
  `src/run-dir/manifest.json`; `regen:static` regenerated (2-line diff);
  `regen:manifest` output **byte-identical** (tripwire — no leaks).
- **Docs sweep**: code comments, package READMEs, CONTEXT.md glossary, ADRs,
  CLAUDE.md, samples — path forms only. Historical records (`.planning/**`,
  retired `obsidian_config.json` prose) untouched.

## Verified

- `bun test` (s2-agent suite) green incl. the moved `src/run-dir/` suite
  (the absolute-exists sentinel for the 3-up computation)
- typecheck + devops `bun run test` green
- `bun-apps/tests` contract suites green (ci-workflow pin lockstep)
- live source smoke: `check-deps.ts` exits 0; `run.sh --list-models` boots
  (the only coverage of run.sh's silent-skip branch)
- acceptance greps: no remaining `s2-agent/run-dir` / `run-dir/manifest`
  path forms outside the documented whitelist

## Decision record

D6 REVISED note in `.planning/2026-08-24-registry-code-as-config/map.md`
(mirroring the D7 REVISED (t03) precedent). Deployed tree unaffected:
it carries no run-dir and the pipeline never copies/regenerates it.
