# Typecheck notes — `bun run typecheck` (= `tsc --noEmit`)

Established in Phase 0 as the type safety net for the `src/obsidian-lib.ts`
structural split (Phase 1+). This file records every intentional scope boundary
and known type gap so nothing is silent.

## tsconfig scope

`tsconfig.json` mirrors the structural-twin sibling `pi-agent-ext-archify`
(`module: "Preserve"`, `moduleResolution: "bundler"`,
`allowImportingTsExtensions`, `verbatimModuleSyntax`, `strict`,
`noUncheckedIndexedAccess`, `noEmit`). This module/resolution combo is required
because the package imports with explicit `.ts` extensions
(e.g. `from "../src/obsidian-lib.ts"`); the `NodeNext` tsconfig used by some
other siblings would reject those.

**Included:** `src/**/*.ts`, `lib/**/*.ts`, `extensions/**/*.ts`
(i.e. all production code + the real `.test.ts` consumers of the public API).

**Excluded (intentional):**
- `extensions/__tests__/fixtures` — contains `search-old-behavior.snapshot.ts`,
  a byte-for-byte regression *baseline* captured as plain text (its header says
  so). It is never imported as a module; type-checking frozen reference text
  would be noise. The `.mjs`/`.txt` siblings are not compiled by `tsc` anyway.
- `extensions/__tests__/perf` — two bench/regression tests that import the
  **sibling** workspace package `perf-harness` (`../../../../perf-harness/src`).
  `perf-harness` carries its own pre-existing type errors that are out of scope
  for this gate; pulling them in would make the obsidian gate non-deterministic
  w.r.t. another package's health. These perf tests still run under `bun test`.

The runtime test safety net is unchanged: `bun test extensions/__tests__/`
(384 pass / 1 fail — the submodule-gated snapshot skip).

## Known type gaps (suppressed, not silent)

### 1. `lib/vaultReport.ts` — orphan `title` field (LATENT BUG, deferred)

```ts
// @ts-expect-error — latent bug (pre-existing, NOT introduced by this task):
// GraphResult exposes the note title via `text`, not `title`; so `r.title` is
// always `undefined` at runtime. Left as-is in Phase 0 to avoid any behavior
// change; tracked here for a dedicated fix.
const orphans = graphOrphans(idx).map((r) => ({ path: r.path, title: r.title }));
```

`GraphResult.text` is documented as "title or the offending link line".
`graphOrphans()` populates `text` with `m.title || m.path`, never a `title` key.
So `r.title` is `undefined` today and orphan titles are dropped from the vault
report. Fixing it (`r.title` → `r.text`) would change report output, which
violates Phase 0's "no behavior change" rule, so it is suppressed + documented
here for a dedicated behavior-fix task.

### 2. `extensions/obsidian.ts` — `_capturedTools` runtime-metadata field

Pre-existing `@ts-expect-error` (around the fat routing tool registration):
`_capturedTools` is runtime-only metadata bolted onto a `ToolDefinition` to let
the routing tool capture per-action sub-tools. It is intentionally not part of
the `ToolDefinition` type. Kept as-is; do not "fix".

## Baseline triage summary (45 → 0 errors)

| Category | Count | Resolution |
| --- | --- | --- |
| `verbatimModuleSyntax` type-only imports (`obsidian.ts`) | 19 | inline `type` modifier added |
| frozen snapshot text (`fixtures/*.snapshot.ts`) | 18 | excluded from compilation |
| sibling-package errors via `__tests__/perf` (`perf-harness`) | 4 | excluded from compilation |
| partial mock vs `ExtensionAPI` (`semanticSearch.test.ts`) | 1 | `as unknown as ExtensionAPI` cast |
| possibly-undefined dispatch (`obsidian.ts:2035`) | 1 | `!` (invariant already enforced by prior validation) |
| latent `GraphResult.title` bug (`vaultReport.ts:70`) | 1 | `@ts-expect-error` + this note |
| **total** | **44 actionable** (+1 header line) | **clean (exit 0)** |
