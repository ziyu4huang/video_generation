# Spec — pi-agent deploy / E2E / extension-development optimization

- **Effort**: `pi-agent-optimization`
- **Date**: 2026-08-20
- **Status**: approved design (user sign-off in session 2026-08-20)
- **Scope decision**: all four workstreams (A fix + B CI gate + C dedup refactor + D ext DX), sequenced A → B → C → D

## Background

Deep review (2026-08-20) of the pi-agent dist deploy chain (devops-owned), its E2E test
suites, and `bun-apps/pi-agent/` + `pi-agent-ext-*` source, cross-checked against upstream
pi (badlogic/pi-mono) extension-authoring guidance. Full findings live in the review
session transcript; the actionable items are summarized per phase below.

## Phase A — fix broken deploy paths + dead code + doc alignment (1 PR)

### Fixes

1. `bun-apps/pi-agent/update-pi.sh:153` — `--rebuild` runs
   `bun scripts/deploy.ts` from the pi-agent cwd; `scripts/deploy.ts` moved to
   `bun-apps/pi-agent-ext-devops/scripts/` in PR #1305 (2026-08-14). Every `--rebuild`
   since then fails silently. Fix: point at `../pi-agent-ext-devops/scripts/deploy.ts`
   (cwd stays pi-agent; `assertCorrectCwd` in deploy.ts:158 requires it).
2. Delete `bun-apps/pi-agent-ext-devops/lib/deploy-swap.ts` + its test — written for the
   old atomic `.prev` swap; today's deploy.ts `rmSync`s the target directly
   (deploy.ts:821). No production caller.
3. Guard against recurrence: add a lightweight test in
   `bun-apps/pi-agent/src/__tests__/e2e-launcher.test.ts` that string-parses
   `update-pi.sh` for referenced script paths and asserts each exists on disk. No actual
   rebuild needed.

### Doc alignment (6 spots)

4. `bun-apps/pi-agent/run.sh:36-38` header + `--update-help` heredoc (`run.sh:80-83`,
   duplicated via the root `pi-agent.sh` symlink): describe the actual pin-edit update
   behavior, not "`bun update <all 4> --latest`" (update-pi.sh:275-303 deliberately
   never runs that).
5. `bun-apps/pi-agent-ext-devops/extensions/devops.ts:711` — `pi_deploy` description
   cites `scripts/deploy.ts` path that no longer resolves from pi-agent cwd.
6. `devops.ts:763` — `pi_verify` "high = the exact CI deploy -- verify job" cites
   ci.yml.disabled which never runs here.
7. `bun-apps/pi-agent-ext-devops/skills/devops-workflow/SKILL.md:187` trigger table:
   add Pipeline B (`deploy:sh` / `deploy-sh-cli.ts`) — currently invisible in the skill.
8. `SKILL.md:229-238` plain-session CLI fallback list: add `verify-deploy-cli`
   (bin `devops-verify-deploy`).
9. `scripts/check-deploy-artifacts.sh:39-41` — stale "no out-dir flag" rationale
   comment (deploy.ts:114 accepts an out-dir positional).

### Cleanup

10. Delete ghost husk dirs (node_modules only, untracked, PR #1490 rename residue):
    `bun-apps/pi-agent-cli/`, `bun-apps/pi-agent-ext-core-runtime/`,
    `bun-apps/pi-agent-ext-core-interface/`, `bun-apps/pi-agent-ext-core-task/`.
11. Delete empty untracked `bun-apps/pi-agent/vault/`.
12. Execute TODO #0 from `bun-apps/pi-agent/TODO.md`: retire the dead
    portable/release layout branches in `run.sh` + `run-dir/resolve.ts`.

### Testing

Existing e2e-launcher tier + new path-existence test; full `bun run test` green for
pi-agent and pi-agent-ext-devops.

## Phase B — change-triggered CI deploy gate (1 PR)

### Problem

`local_ci` never sets `PI_AGENT_E2E`, so the entire L1 deploy tier (patch application,
bundle extension loading, launcher) only runs on manual `run-test.sh` high invocation.
PR #1305-class regressions (deploy-script path drift) landed precisely in this blind
spot.

### Design

1. `bun-apps/pi-agent-ext-devops/src/lib/ci-recipe.ts`: define a **deploy-sensitive glob
   set** — `bun-apps/pi-agent-ext-devops/scripts/**`, `bun-apps/pi-agent/run.sh`,
   `bun-apps/pi-agent/src/cli/**`, `bun-apps/pi-agent/src/patches/**`,
   `bun-apps/pi-agent/src/static-extensions.ts`, `bun-apps/pi-agent/scripts/**`,
   `bun-apps/pi-agent/run-dir/manifest.json`, root `pi-agent.sh`.
2. When the PR's changed-file set intersects that set, local_ci appends a
   `PI_AGENT_E2E=1 bun test` step limited to `e2e-patches` + `e2e-extensions`
   (SOURCE/SNAPSHOT layers only — NOT the 4-cwd DEPLOY matrix, to stay in budget).
3. Shared bundle build: `src/__tests__/e2e-harness.ts` `ensureBundle()` gets a
   per-process cache so `deploy-e2e.test.ts` (devops) and `e2e-extensions.test.ts`
   build the bundle once per run instead of twice.
4. Budget: ≤ +60s on triggering PRs, zero cost on all others; total local_ci stays
   under the 5-minute rule.

### Testing

Pure-function unit tests in the devops package: glob → trigger-set decision table.

### Amendment (2026-08-20, ground truth from a live local_ci run)

The premise "local_ci runs ZERO deploy e2e" was overstated: the
workflow-derived gate suite already runs `Deploy-artifact guard` and
`Deploy-sh L1 e2e` on every run. The actual gap — now closed — was the
`PI_AGENT_E2E`-gated bundle-mode assertions (e2e-patches, e2e-extensions
SOURCE layers), which were manual-tier-only. Item "shared bundle build:
ensureBundle() per-process cache" was moot (cache already existed,
e2e-harness.ts:54-62). Scope otherwise unchanged: change-triggered, ≤ +60s,
glob→trigger decision unit-tested.

## Phase C — runpy shared core + low-risk dedup (3–4 PRs)

### C1 — `@repo/pi-agent-ext-runpy-core` (new package)

Consolidates the copy-drifted flux2/krea2/ltx triplet:

- `paths.ts` path-safety + repo-root resolution (~253/215/276 duplicated lines; absorbs
  devops `src/cli-common.ts` `defaultRepoRoot`)
- `binary.ts` binary runner (~212/183/237 duplicated lines)
- argv-injection guards
- `check-flags` core logic

Each ext keeps a thin config layer (model catalog, flag tables, per-ext deltas).
Target: ~1,500+ net lines removed. Migration order: **ltx first** (smallest dependency
surface) as the pattern validation → flux2 → krea2, each its own PR with the full
per-package regression suite + self-test.

### C2 — movie-director adoption

`pi-agent-ext-movie-director/src/runpy_*.ts` switches to runpy-core repo-root/argv
guards.

### C3 — shared stealth-trim test helper (1 small PR)

`bun-apps/tests/` (the existing cross-package tests home, alongside
`dead-export.test.ts`) exposes
`stealthTrimTest(entryPath, toolName)` + the mock-pi `captureTools` harness; replaces
the 7 copy-drifted `stealth-trim.test.ts` instances (file2md, flux2, knowledge-card,
ltx, power-tool, research-tool, zai-mcp).

### C4 — doctor consolidation + infra parity (1 PR)

- Merge the two doctors (`pi-agent/src/doctor.ts` 612 ln deploy self-check +
  `pi-agent/src/cli/commands/doctor.ts` 372 ln cross-machine check) into one shared
  check core (common `CheckStatus`/`CheckResult` + fs-probing) with two thin entries.
- `bun-apps/tsconfig.base.json`; every ext package `extends` it.
- Canonical script semantics: `typecheck` = tsc, `lint` = biome, `check` unified;
  enforced by a config-parity contract test. Afterwards the CLAUDE.md
  "per-package gates differ" warning paragraph is removed.

### Testing

Per-package `bun run test` (canonical scripts) at every step; wayfind keeps its
`check && typecheck && test` triple.

## Phase D — ext scaffold + manifest single-source (2 PRs)

### D1 — scaffold command

`pi-agent cli ext new <name>` generates the package skeleton:
`extensions/<X>.ts` entry (shim rule built in: 1-line re-export when impl lives in
`src/index.ts`), tsconfig extends base, standard scripts, stealth-trim test template
(using the C3 helper), `package.json` with the `@repo/` workspace link.
New-ext friction drops from 9 manual steps to: scaffold → implement → manifest.

### D2 — manifest single-source codegen (upstream-aligned)

`run-dir/manifest.json` becomes the only human-edited registration point. Generated
from it (committed artifacts, `check:schema`-style):

- `src/static-extensions.ts`
- `src/cli/extensions/registry.ts` `EXTENSION_SPECS`
- `cli/commands/schema-cost.ts` `EXTRA_ENTRIES`
- `ensure-extension-deps` probe list

Existing `manifest-consistency.test.ts` becomes the drift tripwire: manifest vs
generated artifacts mismatch → fail. The self-heal probe's peerDeps/staticExtensions
blind spot class disappears because the probe list is generated, not hand-maintained.

### Testing

Codegen idempotency test + drift tripwire; scaffold output passes the full gate once.

### Amendment (2026-08-20, ground truth from exploration)

D2's four codegen targets, re-audited before implementation:
- `schema-cost.ts` `EXTRA_ENTRIES` — **already manifest-derived** (`discoverExtensionEntries()`,
  #675); EXTRA_ENTRIES is `[]`. No work.
- `ensure-extension-deps` probe list — **already auto-discovers** every `@repo/*` dir from disk;
  `run-dir/deps-probe.ts` is already manifest-driven. No work.
- `src/static-extensions.ts` — the one real remaining drift surface (15 imports + 15 rows
  hand-maintained beside `manifest.staticExtensions[]`). Implemented (PR A): pure generator
  `src/static-extensions-gen.ts` + `regen:static` script + byte-exact drift tripwire in
  `manifest-consistency.test.ts`.
- `src/cli/extensions/registry.ts` `EXTENSION_SPECS` — **NOT derivable** (which packages export
  subcommand specs, symbol names, and the `extensions/cli-subcommand.ts` sub-path are not in the
  manifest; generating them would need new manifest fields duplicating what already lives
  single-sourced in the ext packages). Deliberately stays hand-written.

## Risks & guardrails

- C1 is the only high-risk item (three production pipelines' path/binary guarantees
  change foundation). Mitigation: migrate-one-validate-then-replicate, and Phase B has
  already landed so the deploy tier gates it automatically in local_ci.
- All git operations through the devops tool chain (`prepare_branch` / `local_ci` /
  `await_pr_merge` / `sweep_branches`), never hand-rolled bash.
- `.planning/` artifacts committed per standing rule; per-filename scratch
  (`task_plan.md`, `progress.md`) stays out.

## Non-goals

- No change to the L2 judgment / L3 real-model tiers' opt-in design (PRD-e2e-testing
  layering is deliberate).
- No upstream-pi loader replacement; run-dir manifest model stays.
- models-store-default.ts (1,899 ln) stays as generated data as-is.
