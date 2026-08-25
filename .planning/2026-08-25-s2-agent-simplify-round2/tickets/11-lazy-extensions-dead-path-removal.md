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
- **CONTEXT.md glossary** (:32-38 **Lazy extension** + **Alias resolution** — the latter ALREADY stale: it describes the exact-key→substring→dir-fallback arms removed 2026-08-22; :41-44 run-dir module split names lazy-extensions.ts) — deleting the module without touching these leaves false ubiquitous-language terms
- `resolve.ts:64` re-exports `LazySettings` FROM the module — the type must move (or the re-export go) or resolve.ts keeps importing a deleted file

Removal must keep the registry zero-import contract intact (map D4 lineage) and go `deletion-with-equivalence-proof` per candidate (map D5): each deleted test assertion quotes its surviving cover. Decide in-ticket whether `-e <alias>` bare-name support keeps ANY form (upstream `-e <file>` loading is unrelated and stays).

## Acceptance criteria

- [ ] lazyExtensions gone from registry-config/registry-to-manifest/manifest.json (regen receipts) or an in-ticket verdict records why it stays
- [ ] CONTEXT.md terms updated in the same PR (Lazy extension / Alias resolution / run-dir module split)
- [ ] per-deletion equivalence proofs recorded (D5)
- [ ] `bun run --cwd bun-apps/s2-agent test` + `typecheck` green (incl. the run-context/resolve import-direction contract after the LazySettings move); launcher e2e (run-dir is DEPLOY_SENSITIVE); local_ci green; PR merged; reviewer pass; `--patch` bump
