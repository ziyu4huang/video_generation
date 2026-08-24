---
effort: 2026-08-24-registry-code-as-config
created: 2026-08-24
last: 2026-08-24
status: complete
---

# registry-code-as-config — the registry YAML → typed TS registry (pre-load-providers pattern)

## Destination

The YAML registry is retired. The extension registry lives as ONE typed,
side-effect-free TS module in `bun-apps/s2-agent/src/` (same doctrine as
`pre-load-providers.ts`): every entry — including disabled ones — is a
first-class `enabled: false` value that stays type-checked, enumerable, and
invariant-tested. All six repo consumers import it instead of parsing YAML; the
`ext new` scaffold emits a TS entry; `run-dir/manifest.json` remains DERIVED
with its freshness gate intact; the ordering/host-contract rules that today live
in YAML comments become executable invariant tests.

**CLOSED 2026-08-24** — the registry is now TS-only, released as s2-agent 0.7.0
(PR #1970/#1971 merged CLEAN); the deployed tree carries 0.7.0.

## Context (measured 2026-08-24 on this machine, file:line verified during planning)

- **The registry chain today**: `bun-apps/s2-agent/src/registry-config.ts` →
  `regen:manifest` (`bun-apps/s2-agent/scripts/regen-manifest.ts`) → derived
  `run-dir/manifest.json` (freshness-gated) → consumed by the loader and the
  schema-cost canary (`src/cli/commands/schema-cost.ts` derives from
  manifest.json). Documented in the 2026-08-22-ultracode-rename map (line 26).
- **Real parsers of the YAML (6)**: `run-dir/registry.ts` (authority),
  `run-dir/registry-to-manifest.ts`, `scripts/regen-manifest.ts`,
  `run-dir/registry-insert.ts`, `src/ext-new.ts` (scaffold), and devops
  `src/deploy/lib/config.ts` (`parseShConfig`). ~37 files mention the filename;
  the rest are prose/comments (extension headers, skills docs, tests).
- **The comment-out failure mode is real and recent**: tool-gate (registry
  lines ~245–251) and — as of PR #1958, today — hyperframes are "remembered"
  only as commented YAML: invisible to types, to enumeration, and to invariant
  tests. Re-enabling tool-gate requires uncommenting prose and hoping the
  schema still matches. This is the forcing argument for `enabled: false` as a
  typed field.
- **The proven in-repo specimen**: `bun-apps/s2-agent/src/pre-load-providers.ts`
  — typed config + helpers, side-effect-free by design (header lines 28–39),
  consumed by import (monkey-patch deliberately isolated in `patches/`), with
  direct unit tests (`pre-load-providers.test.ts`, 18 pass in #1957's verify).
- **Contract-suite immunity constraint**: `bun-apps/tests/lib/registry-base-set.ts`
  is a hand-rolled line scanner BECAUSE its consumers must stay immune to
  `bun-apps/node_modules/@repo/*` link state (same reasoning as
  seam-contract.test.ts's relative core-interface import; its header lines
  11–16). Whatever replaces the YAML must preserve this or the contract suites
  get a new failure mode on fresh clones with no `bun install`.
- **Invariant rules currently living in comments only** (registry header +
  entry comments): static order (subagent before ultracode/workflow),
  `hostApi` must equal `HOST_API` in `src/sh/host-modules.ts`, `hostModules`
  must equal `HOST_MODULE_IDS` (deploy hard-fails on drift already —
  ext-build), every non-deploy entry requires `excludeReason`, exactly one
  registry entry per extension folder + one `load:` value.
- **Deploy runtime does NOT read the YAML**: the deployed tree carries
  `deploy.json` / per-ext `ext.json` + `run-dir/manifest.json` written at
  deploy time; `parseShConfig` runs repo-side only (verified: deploy tree
  layout in `src/deploy/lib/ext-build.ts`, ext.json manifest at line ~627).

## Tickets

Execution order (confirm-gate passed 2026-08-24): 01 → 02 → 03 → 04.
01 and 04 are no-choice (module gates all; retirement gated on zero parsers);
02 before 03 by operator choice — 02 closes the registry-insert runtime fog
earliest, 03 is the mechanical surface.

Phase 1 — the module (gates the rest)
- `tickets/01-typed-registry-module.md` — DONE (PR #1962, merged CLEAN
  2026-08-24) — `src/registry-config.ts` shipped: typed entries, `enabled:
  false` first-class (hyperframes + tool-gate with disableReason +
  reEnableNote), zero-import (tokenizer-based test assertion, since notes
  mention require("#pi/ext-dir") in prose), equivalence net 9/9 vs the real
  YAML (parseRegistry + parseShConfig shapes), local_ci pass, s2-agent 0.6.5

Phase 2 — repo consumers flip (after 01)
- `tickets/02-flip-run-dir-consumers.md` — DONE (PR #1965, merged CLEAN
  2026-08-24) — run-dir/registry.ts gained `loadRegistry()` (validation over
  REGISTRY → legacy Registry shape; parseRegistry kept verbatim as the
  retired YAML bridge for devops/ext-new until 03); regen-manifest +
  freshness gate read it; regen output byte-identical (24 extensions); s2-agent
  suite 1055/0; local_ci pass; s2-agent 0.6.7
- `tickets/03-flip-devops-and-scaffold.md` — DONE (PR #1967, merged CLEAN
  2026-08-24) — devops `config.ts` gains `shConfig()` /
  `excludedExtensionsFromRegistry()` over `loadRegistry()` (parseShConfig kept
  as deprecated fixture-only YAML bridge); `--config` flag retired everywhere
  (errors loudly, points at src/registry-config.ts); deploy report
  `configPath` → `registryModule`; `ext new` appends a typed REGISTRY entry
  (`appendRegistryTsEntry` text surgery) — its old text surgeon
  `run-dir/registry-insert.ts` deleted (zero non-test callers left); contract
  suites read a relative import of registry-config.ts (D4), registry-base-set
  test rewritten to real-data invariants; s2-agent 0.6.8; local_ci pass
  (after the probe suite was pinned to the deepseek provider — D8)

Phase 3 — retirement (after 02+03)
- `tickets/04-retire-yaml-invariants-docs.md` — DONE (PR #1970, merged CLEAN
  2026-08-24) — the YAML + its bridges deleted (parseRegistry /
  parseShConfig / excludedExtensions + fixture tests); the equivalence net
  became `legacyRegistry()`, a converter (D9); `$generated` unfrozen;
  single-registry-guard zero-mention form; invariant suite landed in
  registry-config.test.ts (static order, host contract vs host-modules.ts,
  one-entry-per-folder + entry-exists, excludeReason/disabled metadata);
  docs sweep incl. planning archives — `git grep` of the retired filename =
  zero hits; deploy-probe fixture lane 15/15; s2-agent 0.7.0 (minor, per
  ticket); local_ci pass

## Decisions

- D6 (t02, placement — closes the run-dir-vs-src Fog): the registry read
  surface STAYS in `run-dir/`. Reason: validation needs `node:fs` (package/
  entry existence), which `src/registry-config.ts` forbids by contract (D4
  zero-import); the surviving post-04 pieces (validation + the manifest
  emitter) already sit beside `run-dir/manifest.json`, the artifact they
  produce; and the YAML bridge (`parseRegistry`) is transitional — moving it
  now would churn devops/ext-new imports twice (once for the move, again when
  04 deletes it). REVISED (2026-08-24, post-close-out by the run-dir move,
  `.planning/plans/2026-08-24-run-dir-to-src.md`): the "STAYS in run-dir/"
  clause is superseded — the surface now lives at
  `bun-apps/s2-agent/src/run-dir/` (the repo-source resource dir moved whole
  under `src/`). D6's YAML-transitional reason (avoid churning devops/ext-new
  imports twice around the `parseRegistry` deletion) is moot post-t04: the
  YAML bridge is gone, and D4 constrains only `src/registry-config.ts` itself
  — files under `src/` may use `node:fs` freely. Everything else D6 pinned
  survives intact: validation stays beside the manifest emitter, the manifest
  stays DERIVED next to its producer (`src/run-dir/manifest.json`,
  freshness-gated), and the deployed tree never carried run-dir either way.
- D7 (t02, registry-insert — closes the runtime-YAML Fog): registry-insert
  does NOT parse YAML and its sole non-test caller is `src/ext-new.ts`
  (repo-time scaffold CLI). No dynamic run-dir-loading or compiled-binary path
  reaches it — the deploy tree carries deploy.json / ext.json / manifest.json
  written at deploy time (Context, measured). Its flip lands with ext-new in
  ticket 03; ticket 04 deletes it with the YAML. Transitional seam accepted:
  between 02 and 03, `ext new --register dynamic` still writes YAML but
  regen:manifest ignores it — surfaced by the freshness gate going red, fixed
  by 03. REVISED (t03): registry-insert was deleted IN 03, not 04 — ext-new's
  flip to `appendRegistryTsEntry` left it with zero non-test callers, so
  keeping an orphaned module for one more ticket bought nothing; the t04
  deletion scope still owns the YAML + the parseRegistry/parseShConfig
  bridges.
- D8 (t03, CI provider pin — new, operator constraint): the probe e2e suite
  boots the deployed binary with PI_PROVIDER=deepseek /
  PI_MODEL=deepseek-v4-flash-vision-exp / PI_THINKING=off in agentDirEnv, so
  gates never depend on the zai coding-plan quota. Reason (measured
  2026-08-24): BUILTIN_MODEL_DEFAULT is zai/glm-5.3 on the operator's z.ai
  coding-plan account — when the plan limit hits, api.z.ai answers every call
  401 `{"code":"1000","message":"Authentication Failed"}` and the boot prints
  it on stderr, turning the probe's stderr-clean session-start assertion red
  for an operator-account reason (reproduced on the pre-t03 0.6.6 deployed
  tree; `--model deepseek...` boots clean). CI checks the repo, not the
  quota; the operator's real sessions keep the zai default.
- D9 (t04, equivalence net — the effort's last open design point): the t01
  equivalence net is DROPPED, not frozen as a golden snapshot. Reason: the
  net's entire job was proving TS ≡ YAML while the YAML stayed authoritative;
  with zero parsers left there is no second source to be equivalent to, and a
  frozen snapshot would be a mirror of data the test itself is the source of
  — no behavioral guarantee, only churn on every registry edit (spec §3's
  "the shapes ARE the source"; ticket's "prefer deletion"). The legacy
  `Registry` projection survives as `legacyRegistry()` — an internal
  converter consumed by `loadRegistry()` (its contract must not change); the
  projection's shConfig half died with parseShConfig (devops projects its own
  ShConfig). The rule layer is now the executable invariant suite (spec
  §2.3) + run-dir's runtime validation.
- D1: Full replacement, not a hybrid. A TS module that emits YAML (or a YAML
  kept as generated output) would create two sources and re-introduce the
  parse layer; the whole point is one typed authority. Rejected: keep YAML +
  add TS types over it (no behavioral gain for comment-out visibility).
- D2: Disabled extensions are VALUES, not deletions (the tool-gate/hyperframes
  lesson from #1946/#1958): `enabled: false` entries stay in the array, are
  excluded from load/deploy by the consumers, and an invariant test asserts
  every disabled entry carries a reason + a re-enable path comment. This is
  the direct fix for "remembered only as a comment".
- D3: `run-dir/manifest.json` stays DERIVED and freshness-gated. The TS module
  is repo-side source only; the loader/schema-cost canary surfaces do not
  change (they read manifest.json today and keep doing so).
- D4: Contract suites keep link-state immunity: they must read the registry
  without `bun-apps/node_modules` — via a relative-path import of the new
  module (same pattern as seam-contract.test.ts importing core-interface
  relatively), NOT via `@repo/s2-agent`. The module therefore must be
  dependency-free (types + data + pure functions only).
- D5: Ordering matters as migration risk: the module lands first with the YAML
  still authoritative (ticket 01 proves equivalence), consumers flip one
  surface at a time (02, 03), and the YAML is deleted only when zero parsers
  remain (04). No big-bang cutover.

## Frontier

None — the queue is drained (01–04 all DONE). Next work per the 2026-08-24
session close-out's ranked list: **CI-E2E: bound the one-shot runtime +
hermes-memory startup** (user ask 2026-08-24; flat plan seeded:
`.planning/plans/2026-08-24-ci-e2e-oneshot-runtime-hermes-startup.md`), then
hermes-memory startup batching, `.agents/memory` regeneration, devops scripts
timeout control. The next boundary for THIS effort is the close-out: map
status → complete.

## Fog of war

- CLOSED (t02): run-dir vs src placement → Decision D6 (stays in run-dir;
  validation needs node:fs, which registry-config.ts forbids).
- CLOSED (t02): registry-insert runtime YAML surgery → Decision D7
  (repo-time only; sole caller ext-new; no binary/runtime path).
- CLOSED (t02, verified during the flip): schema-cost canary derives from
  manifest.json (no YAML mention at all in `src/cli/commands/schema-cost.ts`);
  `doctor.ts` names the YAML in a comment only and reads `ext.json` trees.
- CLOSED (t04): `lazyExtensions` — consumers: run-dir/lazy-extensions.ts
  (resolveLazyExtension, alias → package path) and run-dir/deps-probe.ts
  (deploy-time check), plus a passthrough into manifest.json. Typed shape
  already exists: `LAZY_EXTENSIONS: Record<string, string>` in
  registry-config.ts (empty today); no further work needed.
- CLOSED (t03): fresh-worktree CI — the GitHub CI workflow is DISABLED
  (`.github/workflows/ci.yml.disabled`); the only working gate is the
  change-scoped `local_ci`, always run inside the workspace-linked checkout,
  so the contract suites never execute without `bun install` today. D4's
  relative import is therefore belt-and-suspenders for CI — but still
  load-bearing for a no-install fresh clone / editor typecheck, so it stays.
- CLOSED (t03, new): gates must not depend on the zai coding-plan quota →
  Decision D8.

## Cross-effort links

Shares-decision-with: 2026-08-22-ultracode-rename — owns the registry-chain
naming convention this effort preserves (manifest.json DERIVED, one entry per
extension).
Builds-on: PR #1958 (2026-08-24, merged) — its hyperframes comment-out is the
second live instance of the comment-out failure mode (D2's forcing argument);
sv-analyzer's new excludeReason entry migrates as data.
