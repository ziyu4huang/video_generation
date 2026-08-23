---
effort: 2026-08-22-s2-agent-simplification
created: 2026-08-22
last: 2026-08-22
status: complete
---
# s2-agent-simplification — dedupe + dead-machinery removal, zero behavior change

## Destination

`bun-apps/s2-agent` carries no copy-pasted helpers across `cli/commands/` and no
machinery over empty registries — while the thin-wrapper architecture (patches,
run-dir manifest, deploy pipeline) and all observable CLI output stay identical.

## Context (measured 2026-08-22 on this machine)

- Package shape: src/ top level 5,199 L; patches 4,249 L; cli/commands 6,137 L;
  sessions 1,102 L; sh 1,011 L; run-dir ~1,400 L source + 1,173 L tests.
  Test:source ratio ≈ 0.65:1 across the package.
- `resolveVaultPath` is byte-identical in zk-ingest.ts:37-48, zk-query.ts:40-51,
  zk-extract.ts:80-91 (`resolveVault`, exported, imported by its own test).
  Two ancestor-walk variants: knowledge-pipeline.ts:41-62 (mkdirs after walk,
  default `vaults_root/s2-agent-vault`), memory-to-vault.ts:121-134 (no mkdir).
- zk-card.ts:45-79 re-implements runAgentSession (run-agent-session.ts:35-71)
  step-for-step; deltas are only `applyVaultEnv(parsed)` first, the
  `[zk-card <sub>]` log prefix, and the `parsed.tools ?? tools` rule.
- `timestamp()`+`iso()` twins: pdf-to-vault.ts:57-61,115 vs memory-to-vault.ts:61,115-119;
  `writePipelineDoc`/`readPipelineDoc` same shape modulo doc type
  (pdf-to-vault.ts:117-138 has a D5 legacy-key migration the memory variant lacks).
- Two independent readers of ~/.pi/agent/settings.json: passthrough.ts:69-81
  (async, dynamic imports) vs sessions/shared.ts:438-446 (sync, static import —
  shared.ts already statically pulls pi-coding-agent at line 27).
- deps-probe.ts:40 `NPM_EXTENSIONS = []` — comment on line 38 says it "stays an
  empty list until the machinery around it is retired". Loops at :61 and :307.
- run-dir/manifest.json:83 `"lazyExtensions": {}`; lazy-extensions.ts steps 2-3
  iterate that always-empty object. resolve.test.ts:343-349 pins `-e workflow`
  → undefined via directory-fallback miss. registry.ts still PARSES non-empty
  alias maps (must not silently strand them if ever re-added).
- Stale prose: cli-sh.ts:7 "which stays the entry for the four legacy deploy
  modes", cli.ts:163 "the deploy modes' self-injected `-ne`" — modes deleted in
  the 2026-08-20 consolidation.
- Prior decisions reused: deploy-architecture consolidation spec
  (`.planning/specs/2026-08-20-deploy-architecture-consolidation-design.md`);
  ADR-s2-agent-0001 (per-command tool curation — untouched).

## Tickets

Phase 1 — duplication extraction
- `tickets/01-vault-paths.md` — shared vault resolvers, **closed**
- `tickets/02-zk-card-run-agent-session.md` — route zk-card through the shared runner, **closed**
- `tickets/03-pipeline-doc.md` — timestamp/iso/pipeline-json micro-module, **closed**
- `tickets/04-settings-reader.md` — one settings.json reader, **closed**

Phase 2 — dead machinery
- `tickets/05-npm-extensions-retirement.md` — delete empty NPM_EXTENSIONS loops, **closed**
- `tickets/06-lazy-alias-shrink.md` — drop arms over the empty alias registry, **closed**
- `tickets/07-stale-deploy-prose.md` — purge legacy-mode comments, **closed**

## Decisions

- D1: No unified `*-to-vault` module. The three pipelines use three different
  execution engines; only their small helpers are shared. Reason: forced
  abstraction would couple unrelated orchestration models.
- D2: `findExistingRun` stays per-command. Slug-suffix matching (pdf) vs
  newest-dir-with-pipeline.json (memory) are different algorithms, not copies.
- D3: T6 keeps a loud warn when the parsed lazyExtensions map is non-empty.
  Reason: registry.ts still accepts aliases; silently stranding a future
  re-added alias is exactly the silent-no-op class this package was bitten by
  before (pre-0.80 loadModels patch incident).
- D4 (deferred): `footer-extension-status-notify` patch is REDUNDANT per its
  own index.ts:118-130 note, and `WRITE_TOOLS`/`dryRunExclude`
  (sessions/shared.ts:181-213) is a documented no-op since the obsidian facade
  collapsed. Both stay until a dedicated effort removes them (patch invariant:
  opt-OFF-not-opt-IN means remove-entirely, which is cross-package churn).
- D5 (deferred, Tier 3): move §4 `DEFAULT_MODELS_STORE` (~1,850 generated lines,
  pre-load-providers.ts:280-2130) to an imported JSON seed. Touches hermetic
  binary seeding; charted only.
- D6: pdf-to-vault's D5 legacy-stage migration survives as a wrapper around the
  shared reader. Reason: old pipeline.json files in existing run dirs must
  resume cleanly.

## Frontier

All tickets closed. Measured result (git diff --stat, this worktree):
**+124 / −317 across 15 modified files + 2 new shared modules**
(`src/cli/vault-paths.ts`, `src/cli/pipeline-doc.ts`) — net ~193 source lines
removed. Verification chain all green: `bun test` 1047 pass / 0 fail,
`tsc --noEmit` clean, `cli list`/`--help` smoke OK, deploy
`0.2.2+g52abe6d` → verify-deploy-e2e **pass** (boot + 17 extensions loaded +
real model call).

## Fog of war

- Whether any external script still passes `-e <alias>` expecting exact-match
  resolution against a NON-empty map — impossible today (map is `{}`), but the
  warn from D3 is the tripwire if one is ever re-registered.
- Tier 3 JSON-move interaction with `--compile-embed` binary seeding unprobed
  (generate-embedded-assets.ts path).

## Cross-effort links

- Builds-on: `.planning/specs/2026-08-20-deploy-architecture-consolidation-design.md`
  — inherits the two-execution-mode world; T7 only purges prose about the four
  modes that spec retired.
- Shares-decision-with: `.planning/2026-08-22-context-lifecycle/` — none direct;
  both touch s2-agent but disjoint files.
