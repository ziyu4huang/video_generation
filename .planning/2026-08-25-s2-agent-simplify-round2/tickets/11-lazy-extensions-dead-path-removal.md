# 11 — lazy-extensions dead-path removal (split out of ticket 06)

Source: ticket 06's "lazy-extensions dead-path fold-in if it fits budget" clause — measured 2026-08-25: it does NOT fit (map Fog anticipated exactly this: "may exceed ticket 06's budget if the manifest-types surface is wider than expected — split rather than cram").

## Scope

`manifest.lazyExtensions` has been `{}` since ultracode went static (lazy-extensions.ts:63 documents it); the resolver + plumbing are a dead path. Surface census (2026-08-25):

- `src/run-dir/lazy-extensions.ts` (153 LOC — the `-e <alias>` rewriter + its warn)
- `src/registry-config.ts`: `LAZY_EXTENSIONS` export (:155), RegistryManifest field (:639), legacyRegistry wiring (:692)
- `src/run-dir/registry-to-manifest.ts` (emits the field) + `src/run-dir/manifest.json` (DERIVED — regen via `bun run regen:manifest`)
- `src/ext-doctor.ts:187-188` (reads it), `src/run-dir/manifest-types.ts:23` (raw-entry backward compat), `src/run-dir/resolve.ts:64` (LazySettings re-export)
- `src/static-extensions.ts` + `src/static-extensions-gen.ts` doc comments (GENERATED — regen via `regen:static`)
- Tests: registry-to-manifest.test.ts, resolve.test.ts, extension-contract.test.ts
- **CONTEXT.md glossary** (:32-38 **Lazy extension** + **Alias resolution** — the latter ALREADY stale: it describes the exact-key→substring→dir-fallback arms removed 2026-08-22; :41-44 run-dir module split names lazy-extensions.ts) — deleting the module without touching these leaves false ubiquitous-language terms. ALSO README.md Extensions section documents `LAZY_EXTENSIONS` on-demand loading (found-stale in ticket 09).
- `resolve.ts:64` re-exports `LazySettings` FROM the module — the type must move (or the re-export go) or resolve.ts keeps importing a deleted file

Removal must keep the registry zero-import contract intact (map D4 lineage) and go `deletion-with-equivalence-proof` per candidate (map D5): each deleted test assertion quotes its surviving cover. Decide in-ticket whether `-e <alias>` bare-name support keeps ANY form (upstream `-e <file>` loading is unrelated and stays).

## Acceptance criteria

- [x] lazyExtensions gone from registry-config/registry-to-manifest/manifest.json (regen receipts) or an in-ticket verdict records why it stays
- [x] CONTEXT.md terms updated in the same PR (Lazy extension / Alias resolution / run-dir module split)
- [x] per-deletion equivalence proofs recorded (D5)
- [x] `bun run --cwd bun-apps/s2-agent test` + `typecheck` green (incl. the run-context/resolve import-direction contract after the LazySettings move); launcher e2e (run-dir is DEPLOY_SENSITIVE); local_ci green; PR merged; reviewer pass; `--patch` bump

## Outcome (2026-08-25)

- **In-ticket verdict — `-e <alias>` keeps NO form; removed entirely.** Measured: zero
  `-e <bare-package-name>` usage repo-wide (the directory-fallback arm's only
  match shape, `<bunAppsDir>/<alias>/extensions/`); the surviving `-e workflow`
  / `-e ultracode` strings are docs/samples pointing at dirs that do NOT match
  the fallback shape (they never hit it — smoke-e2e.ts invokes the full path,
  only its :9 header comment shows the bare form). Registry aliases were
  already `{}`. Upstream `-e <file>` loading was never in this module and is
  untouched.
- **Surface removed (broader than the chart census — grep found 3 more files):**
  lazy-extensions.ts (153 LOC, deleted); resolve.ts re-exports + header;
  patches/load-run-dir-resources.ts call + comment (the REAL consumer the
  census missed); registry-config.ts ×3 (LAZY_EXTENSIONS const, LegacyRegistry
  field, legacyRegistry wiring); run-dir/registry.ts Registry field;
  registry-to-manifest.ts field + emission; ext-doctor.ts lazy check block
  (33 LOC) + manifest type + stale comments; deps-probe.ts lazy loop (always a
  no-op on `{}`); manifest-types.ts `raw` field (zero `.raw` readers repo-wide);
  README.md Extensions sentence; CONTEXT.md (Lazy extension + Alias resolution
  terms deleted, run-dir module split + eager _Avoid_ updated).
  Regen receipts: regen:manifest (24 extensions) + regen:static (16 entries) —
  manifest.json drops the field, static-extensions.ts header re-emitted.
- **D5 equivalence proofs:** (1) resolve.test.ts lazy describes (209 lines, 6
  describes) — the seam itself is deleted; zero importers remain (grep receipt);
  upstream `-e <file>` behavior has no cover here to duplicate. (2)
  registry-to-manifest.test.ts "lazyExtensions passes through verbatim" —
  field gone from emitter+type; every SURVIVING manifest field still pinned by
  its own test ($generated first-key, staticExtensions, skills, extensions).
  (3) extension-contract.test.ts — type-assertion cast only, ENTRIES pipeline
  unchanged. (4) ext-doctor lazy block — live receipt: `ext doctor` 24/24
  healthy after removal. (5) deps-probe loop — provable no-op (`{}` input).
- **Rider (pre-existing main break, not this ticket's seam):** #2035 made
  `RegistryDeployBlock.assets` required without updating
  registry-to-manifest.test.ts fixtures — origin/main `typecheck` was RED;
  added `assets: []` to the 3 inline deploy literals to un-break the gate.
- **Version:** 0.7.19 → 0.7.20 (patch, version-bump-cli: package.json +
  dispatch VERSION). (0.7.19 itself shipped separately between tickets.)
- **Live receipts:** `./s2-agent.sh --version` boot exit 0 (patch chain loads
  without the rewrite call); `ext doctor` 24/24; s2-agent `bun test` 953 pass /
  0 fail / 3 skip (956 tests, 76 files); typecheck clean.
- **Noted for the engine-side doc sweep (map Fog):**
  ext-ultracode samples/smoke-e2e.ts:9 header still documents the bare
  `-e ultracode` invocation form — never matched the fallback arm even before
  this PR; belongs with the existing Path-A engine-doc debt.
