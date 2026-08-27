---
type: task
status: closed
spawned by: 05
---

# 08 — Per-platform ext filtering (D5 build-out)

## Question

How does the registry's platform dimension (D5, ticket 01's decision) get
built out: which exts are darwin-by-nature (movie-director, flux2/krea2/ltx
swift runners, MLX-domain tools), how is that expressed in
`bun-apps/s2-agent/src/registry-config.ts`, and how does Gate 3 verify
per-tree expected ext counts when a non-host tree can only be booted on its
own OS?

## Notes for the resolver

- Spawned from ticket 05 (2026-08-27): the D6/D7 pipeline side landed
  without it — the registry lives in the s2-agent package (separate PR
  surface), and the filtering is unobservable until t06 boots a non-host
  tree. Do it after t06's verification channel exists, so the per-tree
  Gate 3 counts are checkable, not aspirational.
- Today a win32/linux tree still ships darwin-by-nature exts (dead weight;
  they fail to load at runtime at worst). The D5 decision text is the
  authority: "non-darwin trees drop darwin-by-nature exts; registry gains a
  platform dimension; Gate 3 verifies per-tree expected counts."
- Deploy-side hook already exists: `buildExtPackage` receives the target
  spec via vendor pass-through (t05) — filtering the `enabled` list in
  `run.ts` by a registry `platforms` field is the natural seam.

## Resolution (2026-08-27)

**Answer: the seam landed; the premise's dead-weight concern was already
solved — MEASURED 2026-08-27, every darwin-by-nature ext
(flux2/krea2/ltx/research-tool/zai-mcp/movie-director — the swift-CLI +
MPS family, registry lines 499–549) carries NO deploy block (excludeReason
"bound to this machine's swift CLIs and services") and was already absent
from EVERY tree. sv-analyzer likewise excluded (wasm artifact). So D5's
build-out is the DIMENSION + filter + per-tree counts, landing as the
identity over today's registry.**

### Landed

- **Registry dimension**: `RegistryEntry.platforms?: Array<"darwin" |
  "linux" | "win32">` — absent = portable (ships to every target). Threaded
  through `legacyRegistry()` → `RegistryExt` → `ShExtConfig`.
  `loadRegistry()` validates values (known platforms, no duplicates).
  No shipped entry carries the field today — the type + filter test is the
  tripwire for the first platform-bound SHIPPING ext.
- **`filterForTarget(extensions, platform)`** (devops config.ts, pure):
  splits deploy-enabled entries into `shipped` / `dropped` by target
  platform; disabled entries are neither. `run.ts` builds the tree from the
  shipped half.
- **Per-tree deploy.json**: the tree's `config.extensions` is now the
  FILTERED set (not the registry projection), plus a `platformDropped`
  array when non-empty — Gate 3 (host trees, via `verifyDualState(stage,
  enabled)`) and verify-deploy-e2e (`--ext-list` vs deploy.json enabled)
  therefore compare PER-TREE expected counts on any OS. Non-host trees'
  Gate 3/6 remain t05-skipped; the t06 native-runner channel boots them
  against the same per-tree set.
- **Report**: platform-dropped rows join the deploy-report's excluded
  table with an explicit D5 reason.
- **Tests** (`tests/deploy-platform-filter.test.ts`): portable-ships-
  everywhere; darwin-only drops from linux/win32; multi-platform lists;
  disabled entries not reported dropped; LIVE-registry identity assertion
  (no shipped entry has `platforms` — forces conscious update).

### Measured (this machine, 2026-08-27)

- Real cross-deploy smoke with the filter in: `--target linux-x64-glibc
  --force` → ok, bun cache hit, deploy.json `config.extensions` = 15
  entries, `platformDropped` absent (identity, correct).
- Gates: devops `bun run test` 970+/0 + `check` (biome+tsc) clean;
  s2-agent `bun run test` 973/0; `regen:manifest` no drift.

### Honest gaps

- No shipped entry exercises the non-identity path in production yet — the
  filter's behavioral proof is unit-level + the identity smoke. The first
  platform-bound shipping ext (e.g. a future MLX tool that deploys) is the
  real-world exercise.
- Gate 3 on a non-host tree still cannot run on the build host (bun is
  foreign) — that is t05/t06's standing topology statement, verified via
  the Actions channel's native runner instead.
