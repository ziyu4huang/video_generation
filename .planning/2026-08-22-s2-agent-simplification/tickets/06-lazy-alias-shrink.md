# T6 — lazy-alias shrink (conservative)

lazy-extensions.ts:

- Remove exact-match (step 2) + substring-match (step 3) arms over the
  always-empty `manifest.lazyExtensions`.
- Add a loud warn when the parsed map IS non-empty (D3 tripwire — registry.ts
  still parses aliases; silently stranding one would be a silent no-op).
- Keep `looksLikeAlias`, directory fallback, `rewriteExtensionArgs`,
  `rewriteArgvLazyExtensions`, `LazySettings`.

resolve.test.ts: drop exact/substring-arm tests; add non-empty-map-warns test;
keep the integration guard (`-e workflow` → undefined via fallback miss) and all
rewrite tests.

**Verify**: resolve.test.ts + full suite + boot smoke.

Status: **closed**
