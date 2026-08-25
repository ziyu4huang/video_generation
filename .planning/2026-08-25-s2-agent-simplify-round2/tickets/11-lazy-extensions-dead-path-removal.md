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

Removal must keep the registry zero-import contract intact (map D4 lineage) and go `deletion-with-equivalence-proof` per candidate (map D5): each deleted test assertion quotes its surviving cover. Decide in-ticket whether `-e <alias>` bare-name support keeps ANY form (upstream `-e <file>` loading is unrelated and stays).

## Acceptance criteria

- [ ] lazyExtensions gone from registry-config/registry-to-manifest/manifest.json (regen receipts) or an in-ticket verdict records why it stays
- [ ] per-deletion equivalence proofs recorded (D5)
- [ ] `bun run --cwd bun-apps/s2-agent test` + `typecheck` green; launcher e2e (run-dir is DEPLOY_SENSITIVE); local_ci green; PR merged; reviewer pass; `--patch` bump
