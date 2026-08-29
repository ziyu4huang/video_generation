---
type: task
status: closed
---

# 01 — Standalone shim entry (`src/sh/standalone.ts`)

## Question

What exact API does the side-effect-free standalone entry export, and does
it evaluate a deployed `ext/<name>/ext.cjs` correctly with the shim's own
inlined host registry?

## What to build

A new entry in `bun-apps/s2-agent/src/sh/standalone.ts` exporting
`loadExt(name, opts?)` → `{ name, manifest, tools(), tool(name) }` and
`listExts(opts?)`, implemented by re-exporting the REAL
`extRequire` / `evaluateExtModule` (ext-loader.ts) and the REAL host
registry (host-modules.ts) — no second loader implementation, no import of
any cli-sh boot path. Errors throw loudly with the ext name and reason
(unknown ext, no callable default, unknown tool, evaluation failure).
Default dist root derives from the wrapper's real `module.filename`
(no in-code `__dirname` literals — bun's cjs output folds them to
build-machine paths); `opts.distRoot` overrides. Reading the sibling
`ext.json` manifest is part of `loadExt`.

## Acceptance

- [ ] `loadExt` on a fixture ext dir (cjs bundle built with the same
      `bun build --format=cjs` shape) registers tools, serves
      `#pi/ext-dir`, and `tool(name).execute(...)` returns the fixture
      tool's result
- [ ] Unknown ext / no callable default / unknown tool each throw an error
      whose message names the ext or tool and the reason
- [ ] `listExts()` enumerates fixture manifests; `distRoot` override
      resolves a non-default root
- [ ] `bun run test` green for the s2-agent package (canonical gate)
