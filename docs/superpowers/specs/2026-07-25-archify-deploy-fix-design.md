# Archify — Deploy-Bundle Path Fix (Design)

- **Date:** 2026-07-25
- **Scope:** `bun-apps/pi-agent-ext-archify/` (primary) + `bun-apps/pi-agent/scripts/lib/build-extensions.ts` + two schema-cost baselines
- **Status:** Approved (design)
- **Predecessor:** `receipts/archify-deep-audit-2026-07-25.md` (read-only audit that surfaced these findings)
- **Mode:** Implementation design — supersedes the read-only charter of the audit.

## Context

The deep audit (`receipts/archify-deep-audit-2026-07-25.md`) found one **Critical** integration
defect and four **Important** findings. This design defines the fix for all five. The Critical
defect: under the DEFAULT deploy mode (`deploy-bundle`), `scripts/deploy.ts` never copies
archify's `vendored/` tree into the target, so `lib/run.ts`'s `VENDORED_BIN` resolves to a
nonexistent path and all three tools (`archify_render` / `archify_validate` / `archify_delta`)
silently die with `Cannot find module`. Source mode and `--snapshot` mode are unaffected; the
defect is invisible to the test suite (every archify test imports `lib/*.ts` directly, so the
bundle-layout path is never exercised).

A context check during design corrected one assumption in the audit receipt: a walk-up probe in
`run.ts` alone is **insufficient**, because in a clean deploy the `vendored/` tree is never
staged for the probe to find. Any complete fix requires **both** a deploy-side copy and a
resolution improvement in `run.ts`. This design does both.

## Goal

Make all three archify tools work in `deploy-bundle` mode (the default), with a resolution
strategy that also keeps source/snapshot mode working unchanged, plus an operator escape hatch.
Additionally: surface a clear error when the bin is missing (instead of blaming IR validity),
and re-enable the schema-cost canary's coverage of archify across the repo.

## Non-goals

- **No vendored edit** — `vendored/` is a snapshot; untouched (snapshot policy).
- **No D5 dead-code pruning** — all D5 findings are record-only inside `vendored/`.
- **No `lib/inspect-artifact.ts` relocation** — D2 Minor, coupled to the #799 eval surface;
  separate cycle.
- **No mid-flight abort test** — D1 Info gap; recorded, not addressed here.

## Architecture

Two clusters with an internal ordering dependency:

- **Cluster A (archify-internal, first):** the Critical path fix (deploy staging + `run.ts`
  resolution ladder) and the Important misleading-error fix. Both live inside archify plus the
  shared `build-extensions.ts`.
- **Cluster B (canary triplet, second):** repair the `@repo/pi-agent-ext-subagent` symlink, then
  add archify to `boot-smoke.baseline.json`, then refresh `schema-cost-baseline.json`. Items 2
  and 3 depend on item 1 (the canary cannot measure until it runs).

## Cluster A — design

### A1. `lib/run.ts` — resolution ladder

Replace the `VENDORED_BIN` constant with a `resolveVendoredBin()` function:

1. **Env override** — if `process.env.PI_ARCHIFY_BIN` is set, use it verbatim (operator escape
   hatch; consulted first so it wins in every mode).
2. **Walk-up probe** — starting at `dirname(fileURLToPath(import.meta.url))`, check that dir and
   each ancestor (up to 6 levels, stopping at the filesystem root) for a `vendored/bin/archify.mjs`
   file; return the first `existsSync` hit.
3. **Fallback** — the legacy source-relative path `join(PKG_ROOT, "vendored/bin/archify.mjs")`
   where `PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")`. Preserves today's
   return value when nothing is found, so the pre-flight warning (A3) is the surfacing mechanism
   rather than a thrown error.

Cross-mode verification of step 2:

- **Source mode** — module at `<pkg>/lib/run.ts`; probe starts at `<pkg>/lib`, finds
  `<pkg>/vendored/bin/archify.mjs` at depth 1. ✓
- **Snapshot mode** — whole package copied; same shape as source. ✓
- **Bundle mode** — module at `<target>/ext-bundles/pi-agent-ext-archify.thin.js`; probe starts
  at `<target>/ext-bundles`; with A2 staging `vendored/` there, finds
  `<target>/ext-bundles/vendored/bin/archify.mjs` at depth 0. ✓

The resolver runs once at module load; `VENDORED_BIN` becomes `const VENDORED_BIN =
resolveVendoredBin();` so the rest of the module (and the spawn call at `run.ts:24`) is unchanged.
For testability, `resolveVendoredBin` accepts an optional `startDir` parameter (defaulting to
`dirname(fileURLToPath(import.meta.url))`); production calls it with no argument, unit tests pass
a temp directory so the ladder can be exercised without redirecting `import.meta.url`.

### A2. `scripts/lib/build-extensions.ts` — stage vendored assets

After `buildExtensions(targetDir)` builds all thin bundles, call a new
`stageVendoredAssets(targetDir)`:

- Iterate the same manifest extension entries already parsed by `buildExtensions`.
- For each entry, resolve its package dir under `BUN_APPS_DIR` (entry path's first segment).
- If `<pkgDir>/vendored/` exists, `cpSync` it to `<targetDir>/vendored/`
  (`{ recursive: true, force: true }`), and log `✓ vendored/ (from <name>)`.

**Naming assumption (recorded):** `<targetDir>/vendored/` is a shared location. Today only
archify ships a `vendored/` tree, so no collision is possible. If a second extension later adds a
`vendored/` tree, this design must be extended to a per-extension subdir plus a name-aware probe
in `run.ts`. This is explicitly out of scope now (YAGNI).

### A3. Important 1 — misleading error

Two coordinated changes so a missing bin reads as a missing bin, not an IR problem:

- **`lib/run.ts` (`runArchify`):** before spawning, pre-flight `existsSync(VENDORED_BIN)`. If
  absent, resolve immediately with
  `{ stdout: "", stderr: "archify vendored bin not found at <VENDORED_BIN>; deploy may have omitted vendored/", status: 1 }`
  — do not spawn. (One-time `console.warn` at module load is optional; the per-call guard is the
  load-bearing one because env overrides can point anywhere.)
- **`lib/render.ts:56-60`, `lib/validate.ts:28-33`, `lib/delta.ts:29-30`:** when
  `status !== 0 && stdout === ""`, lead the surfaced message with `stderr` and **drop the default
  "Validate the IR first" framing**. Only suggest IR validation when `stdout` is non-empty (i.e.
  archify itself ran and produced output implying an IR problem).

## Cluster B — design (canary triplet, ordered)

### B1. Important 2 — repair the `@repo/pi-agent-ext-subagent` symlink

- Run `bun install` from `bun-apps/` to link `@repo/pi-agent-ext-subagent` into
  `pi-agent-ext-knowledge-card/node_modules/@repo/`.
- **Verify:** `bun scripts/check-schema-cost.ts` exits 0 (no longer exit 1 on
  `Cannot find module '@repo/pi-agent-ext-subagent'`).
- **Stop condition:** if a fresh `bun install` does NOT clear the error, this is a declared-dep
  problem in `knowledge-card/package.json`, not an install gap. Halt B2/B3 and report — the
  baseline refresh (B3) is meaningless until the canary actually runs.

### B2. Important 3 — add archify to boot-smoke baseline

- Edit `bun-apps/pi-agent-cli/src/__tests__/__fixtures__/boot-smoke.baseline.json`: add
  `"archify"` to the `sourceMinimum` list (currently 13 sources; archify is registered in
  `run-dir/manifest.json` but absent from the list).
- This gives archify a CI-locked presence in the schema-cost boot-smoke guard.

### B3. Important 4 — refresh schema-cost token baseline

- After B1 confirms the canary runs:
  `bun bun-apps/pi-agent-cli/src/cli.ts tools-metrics --schema-cost --json > scripts/schema-cost-baseline.json`
- This absorbs archify (515 tokens / 3 tools) plus the other un-baselined sources
  (research-tool, deploy, tool-gate) that currently read as a spurious ~23% inflation against the
  stale baseline.

## Testing

The audit's headline verification gap: **no test simulates the bundle layout.** This design
closes it.

- **New `__tests__/vendored-bin-resolution.test.ts`**
  - Unit: `resolveVendoredBin(startDir)` ladder — env override wins; walk-up hit when a
    `vendored/bin/archify.mjs` is staged at `startDir` or an ancestor; fallback path returned
    when nothing exists (assert the returned path equals the legacy source-relative form).
  - Integration: `mkdtemp` a layout `<tmp>/bundle/ext-bundles/` with a real
    `vendored/bin/archify.mjs` copied to `<tmp>/bundle/ext-bundles/vendored/`, call
    `resolveVendoredBin("<tmp>/bundle/ext-bundles")` (simulating the bundle's `dirname`), and
    assert it returns the staged bin path; then assert `runArchify` spawns it successfully. This
    is the test that would have caught the Critical defect.
- **New build-extensions staging test** (pi-agent scripts side): invoke
  `stageVendoredAssets` against a temp target with a fixture `<pkgDir>/vendored/`, assert the
  tree is copied to `<targetDir>/vendored/`.
- **Important 1 regression:** when `VENDORED_BIN` points at a nonexistent path, the surfaced
  tool message contains `"vendored bin not found"` and does **not** contain `"Validate the IR"`.
- **Gate:** all 11 existing archify tests pass; `bun scripts/check-schema-cost.ts` exits 0 after
  Cluster B.

## Verification

- A1/A2: the new resolution + staging tests pass; a manual `deploy-bundle` to a scratch target
  followed by invoking a tool through the bundle confirms end-to-end (the audit verified the
  failure mode via direct `spawnSync`; the fix verifies the success mode through the deploy
  layer).
- A3: misleading-message regression test passes.
- B1/B2/B3: `check-schema-cost.ts` exits 0 and archify appears in the live report and in both
  baselines.

## Boundaries & safety

- `vendored/` is never edited (snapshot policy).
- `run.ts` change is additive (resolution function + pre-flight guard); spawn contract
  (`shell:false`, no PATH, both `error`/`close` resolve) is preserved unchanged.
- `build-extensions.ts` change is a new function called after the existing build loop; no change
  to bundle output or externals.
- Baseline files (B2/B3) are data-only edits, scoped to archify's addition and a measured
  refresh.
