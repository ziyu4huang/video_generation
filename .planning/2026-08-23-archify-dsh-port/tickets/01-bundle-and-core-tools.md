---
type: task
status: open
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

- [ ] `plugin/package.json` declares `dsh.bundle.patch` → `cordis.patch.yml` (one `insert` row) and `main: index.js`
- [ ] `plugin/index.js` injects `['tools']`, registers the three tools, and tears down via `ctx.effect`
- [ ] Each tool's `parameters` / `output.schema` is raw JSON Schema (no typebox DSL); the render is size-capped
- [ ] `lib/run.ts` resolves Bun (`ARCHIFY_RUNTIME` → PATH → error) and spawns `bun <vendored bin>`
- [ ] `plugin/vendored/` mirrors the s2-agent vendored archify tree
- [ ] `test/plugin-smoke.mjs` (Node) registers the three tools and runs a real `validate` under Bun, asserting a clean receipt
