---
type: task
status: done
---

# 01 — Bundle scaffold + validate/render/delta on `ctx.tools`

## Question

Create the DSH bundle shape and land the three core tools (`validate` / `render` / `delta`) running the
vendored archify CLI under Bun.

## What to build

A `dsh-plugin/archify/` bundle whose `plugin/index.js` registers `archify_validate`, `archify_render`, and
`archify_delta` on `ctx.tools`; each tool spawns `bun <vendored/bin/archify.mjs> <op> …` and parses the
`--json` receipt. The vendored archify tree is mirrored into `plugin/vendored/`. The Bun runtime is
resolved via the ladder `ARCHIFY_RUNTIME` → `bun` on PATH → a clear error. Inline `ir` JSON is written to a
temp file; `irPath` / `outputPath` / `basePath` / `headPath` resolve against the session workspace cwd.

## Acceptance

- [x] `plugin/package.json` declares `dsh.bundle.patch` → `cordis.patch.yml` (one `insert` row) and `main: index.js`
- [x] `plugin/index.js` injects `['tools']`, registers the three tools, and tears down via `ctx.effect`
- [x] Each tool's `parameters` / `output.schema` is raw JSON Schema (no typebox DSL); the render is size-capped
- [x] `lib/run.ts` resolves Bun (`ARCHIFY_RUNTIME` → PATH → error) and spawns `bun <vendored bin>`
- [x] `plugin/vendored/` mirrors the s2-agent vendored archify tree
- [x] `test/plugin-smoke.mjs` (Node) registers the three tools and runs a real `validate` under Bun, asserting a clean receipt

## Resolution

Built and verified the full bundle. `node test/plugin-smoke.mjs` passes (schema shape guard + a real
`archify_validate` through the tool under Bun: `result.valid === true`, `report.ok === true`, 9 checks,
`composition.summary.errors === 0`). Also exercised `render` → `deliver --json` (9/9 checks, sha256
`3f7634…`, 593 815 B HTML) and `delta` → `compare` (28/28 checks, receipt sidecar) end-to-end under Bun.

Deltas from the spec worth recording:

- **Lib is `.ts` shipped alongside Node's type-stripping, not compiled `.js`.** The DSH host runs Node
  v26.7.0, which type-strips `.ts` on import (verified: `index.js` → `./lib/run.ts` cross-extension works).
  So `lib/run.ts` / `load-ir.ts` / `output-path.ts` are shipped as source and `engine.node >= 23.6`
  (type-stripping is on by default there). If a host < 23.6 must load this, that is the one pin.
- **Bundle-relative resolution replaced the `#pi/ext-dir` idiom.** `run.ts` resolves `vendored/` from
  `import.meta.url` (the DSH bundle is imported as ESM, never bundled into a build-machine path literal),
  not the s2-agent `#pi/ext-dir` imports entry — that idiom is pi-agent-specific and doesn't exist in DSH.
- **`resolveRuntime` scans PATH directly.** The s2-agent uses `globalThis.Bun.which('bun')`; under the Node
  host `globalThis.Bun` is undefined, so `run.ts` splits `PATH` and looks for a `bun` executable (D1 ladder
  honoured: `ARCHIFY_RUNTIME` → `bun` on PATH → clear error).
- **No webui announce (D4).** The DSH adapter is a no-op bus; the render/delta tools return their result
  without emitting `webui:open` / `webui:deck`.
- **`ensureFiberActive` guard.** A tool call through a disposed fiber fails cleanly (matching sv-analyzer's
  no-crash-on-dead-fiber behaviour) instead of half-working.
