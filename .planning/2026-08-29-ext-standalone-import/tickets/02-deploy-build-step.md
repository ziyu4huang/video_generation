---
type: task
blocking: 01
status: closed
---

# 02 — Deploy build step: produce `ext/ext-standalone.mjs` + gates

## Question

How is the shim built, cached, and gated so it ships with every deploy as a
first-class dist artifact?

## What to build

In `bun-apps/s2-agent-ext-devops/src/deploy/`: a `lib/standalone-shim.ts`
build step invoked from `run.ts` next to `buildCore` —
`bun build <s2-agent>/src/sh/standalone.ts --target=bun
--minify` (ESM output, same shape as the core bundle — `import.meta.dir`
self-location, see map D4) into `<staging>/ext/ext-standalone.mjs`, content-addressed cache
in the `.cores` style (hash = shim source closure + resolved pi-coding-agent
version + Bun.version + flags; hardlink on hit; freeze chmod read-only).
Apply the existing gate family to the shim artifact: Gate 1 (foreign bare
specifiers — allow-list is builtins only, everything else inlined), Gate 4
(`scanForeignPaths`; if pi package inlining folds `import.meta.url` asset
paths, apply `rewriteAssetImportMetaFolds`), and extend offline Gate 5
containment scanning to cover the shim file. Record
`standaloneShim: { bytes, cached }` in `deploy.json`. Pin the measured
bundle size in the effort map's Context.

## Acceptance

- [ ] A deploy (fresh or noop) produces `ext/ext-standalone.mjs`; second
      deploy with unchanged inputs is a cache hit (`cached: true`)
- [ ] Gate 1 rejects a poisoned fixture (foreign specifier); Gate 4 rejects
      a baked build-machine path — unit-tested with fixtures
- [ ] Offline Gate 5 scans the shim; `deploy.json` carries the
      `standaloneShim` record with measured bytes
- [ ] `--ext-list` dual-state gate still green with the shim file present
      (runtime loader ignores non-dir entries — verified, not assumed)
- [ ] `bun run check && bun run typecheck && bun test` green for
      s2-agent-ext-devops (canonical gate)
