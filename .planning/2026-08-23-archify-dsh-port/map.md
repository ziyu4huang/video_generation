---
effort: 2026-08-23-archify-dsh-port
created: 2026-08-23
last: 2026-08-23
status: active
---

# archify-dsh-port — archify diagram + deck tooling, ported to DeepSeek Harness

## Destination

A self-contained DSH **bundle** at `dsh-plugin/archify/` that gives any agent in a dsh profile the four
archify tools — `archify_validate`, `archify_render`, `archify_delta`, `archify_export_pptx` — with every
CPU/rendering step executed by **Bun** subprocesses and only a thin Node adapter registered on
`ctx.tools`. The source stays as-is at `bun-apps/s2-agent-ext-archify/`; this is a port, not a rewrite,
and follows the same bundle shape `dsh-plugin/sv-analyzer/` established (package.json `dsh.bundle` →
`cordis.patch.yml` → `ctx.tools.register`).

## Context (measured 2026-08-23 on this machine)

- **DSH is Node; Bun is present.** `node --version` → v26.7.0 and the running GUI is
  `node /opt/homebrew/bin/dsh web`. `bun --version` → 1.4.0, on PATH. Bun is the only external runtime
  this port needs.
- **The vendored CLI runs under Bun, byte-for-byte identical to Node.** `bun vendored/bin/archify.mjs`
  `validate` / `deliver` / `compare` all exit 0; `deliver` yields sha256 `dcf970…`, 588 819 B — the same
  artifact as the `node` run. Under Bun, `process.versions.node` = `26.3.0`, so the `>=18` gate in
  `commandDoctor` (`vendored/bin/archify.mjs:1013`) passes.
- **The s2-agent runtime already prefers Bun.** `bun-apps/s2-agent-ext-archify/lib/run.ts`
  `resolveRuntime()` returns `bun` on PATH first — Bun is the designed runtime there, not a fallback.
- **Core tools are thin subprocess wrappers.** `archify_render` / `archify_validate` / `archify_delta`
  (`lib/render.ts`, `validate.ts`, `delta.ts`) spawn the vendored `archify.mjs` through `node:child_process`
  and parse its `--json` receipt. The heavy work is the CLI, so they port by re-wiring only the tool hook
  (pi-agent `defineTool` + typebox → DSH `ctx.tools.register` + raw JSON Schema).
- **The bundle is verified end-to-end on the DSH host (measured 2026-08-23).** `node
  dsh-plugin/archify/test/plugin-smoke.mjs` passes; a real `archify_validate` through the tool under Bun
  returns `ok:true`, 9 checks, `composition.summary.errors === 0`. `render` → `deliver --json` yields a
  593 815 B HTML (sha256 `3f7634…`, 9/9 checks); `delta` → `compare` yields a 1.67 MB HTML + receipt
  (28/28 checks). The bundle packs to a 301 kB tarball (60 files, 1.5 MB unpacked). DSH runs Node v26.7.0,
  which type-strips the shipped `.ts` lib files.
- **`export_pptx` is the Bun-heavy in-process half.** `lib/export-pptx.ts` runs `buildDeck`
  (`lib/deck-build.ts`) in-process; the Bun-only builtins it needs are `HTMLRewriter` (`svg-model.ts`),
  `Bun.XML` (`ooxml-lint.ts`), `Bun.file` / `Bun.write` (`deck-build.ts`), `Bun.spawn` / `Bun.which` /
  `Bun.Glob` (`deck-render.ts`), `Bun.WebView` / `Bun.Image` (`thumbnails.ts`).

## Tickets

Phase 1 — core tools
- `tickets/01-bundle-and-core-tools.md` — task, **done** — bundle scaffold + validate/render/delta on
  `ctx.tools`, Bun runtime resolution, vendored mirror, smoke.

Phase 2 — deck
- `tickets/02-deck-pptx-subprocess.md` — task, **open** — export_pptx tool + `deck-cli.ts` Bun entrypoint
  + deck lib copy + deck smoke.

Phase 3 — packaging
- `tickets/03-bun-build-install.md` — task, **open** — Bun build/install script (replaces `build.sh`),
  `--check-patch`, install into a dsh profile.

Phase 4 — surface
- `tickets/04-docs-and-examples.md` — task, **open** — README, example IR/deck fixtures, skill guidance.

## Decisions

- **D1 — Bun is the single external runtime for all four tools.** Honours the repo's AGENTS.md
  preference (replace node/python/bash where possible) and is verified safe: the vendored CLI is
  Bun-compatible and the s2-agent runtime already prefers Bun. Runtime resolution ladder:
  `ARCHIFY_RUNTIME` env override → `bun` on PATH → clear error.
- **D2 — the Node adapter stays thin and unavoidable.** `index.js` + core tool wrappers are evaluated
  inside the DSH Node process (`ctx.tools.register`), so they are Node ESM; but they use only
  `node:child_process` / `path` / `fs` to spawn Bun. No heavy work lives in Node.
- **D3 — reuse the s2-agent deck code verbatim under a Bun subprocess.** `export_pptx` spawns
  `bun <lib/deck-cli.ts>`, which calls `buildDeck` / `manifestFromIrPaths` unchanged, so `HTMLRewriter`,
  `Bun.XML`, `Bun.file` etc. run on the real Bun runtime. No Node port of the deck half.
- **D4 — webui announce is a no-op bus in DSH.** archify emits `webui:open` / `webui:deck` for the
  s2-agent webui; DSH has no webui, so the DSH adapter passes a no-op event bus through the
  `announceDeck` / `announceOpen` calls (D3).
- **D5 — the bundle requires Bun on the host for the whole toolset.** A deliberate trade-off: the port is
  self-contained in *Bun*, not Node (unlike sv-analyzer's WASM). `ARCHIFY_RUNTIME=node` stays a documented
  escape hatch for a Bun-less host (archify.mjs runs on both).
- **D6 — ship the vendored archify tree unchanged.** `vendored/` is a snapshot of archify@2.12.0; never
  edit in place — re-copy from upstream to re-sync (same policy as the s2-agent extension).

## Frontier

Ticket `02` — the deck `export_pptx` tool as a Bun subprocess. Ticket 01 is done: the bundle shape, Bun
runtime ladder, vendored mirror, and the three core tools are landed and verified. Ticket 02 builds on the
same bundle — it adds a fourth tool that spawns `bun <lib/deck-cli.ts>` (running the s2-agent `buildDeck`
verbatim) plus the deck lib copy and a deck smoke — and drops straight into the scaffold 01 established.

## Fog of war

- **`HTMLRewriter` / `Bun.XML` availability inside a clean Bun install of the deck lib.** The deck lib
  assumes it runs under Bun (these are Bun globals); confirmed available under `bun`, but a compiled-Bun
  binary variant (Approach 2, rejected) breaks `runArchify`'s inner `deliver` spawn because
  `process.execPath` isn't `bun` — charted-but-rejected.
- **`thumbnails` (`Bun.WebView`/`Bun.Image`) and the `deck render` PNG preview** (real renderer / Quick Look)
  are deferred: they need a WebView or an external renderer and are off by default. Parity only; not a build
  gate.
- **`ARCHIFY_RUNTIME` default.** Whether the port should hard-require Bun or fall back to Node when Bun is
  absent is charted; D1/D5 choose Bun-required with a documented `node` override, not an auto-fallback.
- **Upstream re-sync of `vendored/`.** A re-sync could rename `bin/`, `assets/`, or `?embed=`; the s2-agent
  README already warns `bin/` + `assets/` are load-bearing (`loadDiagram` reads `assets/template.html`).

## Cross-effort links

- **Builds-on**: `bun-apps/s2-agent-ext-archify` (the source being ported) and specifically
  `.planning/2026-08-21-archify-view-pptx-bun` (ShapeIR seam D1, `HTMLRewriter` parser D2, native-shape PPTX)
  and `.planning/2026-08-21-archify-slide-composition` (six layouts, `PlacedBlock` seam D2,
  `Bun.XML`/`HTMLRewriter` split D6). The DSH port keeps that engine and adds only the harness-facing adapter.
- **Shares-decision-with**: `.planning/2026-08-22-archify-general-deck` and the s2-agent `run.ts` — the
  Bun-first runtime choice (D1) is the same decision that extension already made (`resolveRuntime()`).
- **Not superseding**: this port does not supersede any archify effort; the s2-agent extension stays the
  upstream implementation and the future re-sync source.
