---
type: task
blocking: 01
status: open
---

# 02 — `archify_export_pptx` via a Bun `deck-cli` subprocess

## Question

Land `archify_export_pptx` so the deck builds on the real Bun runtime, without a Node port of the deck lib.

## What to build

A DSH tool adapter whose `execute` spawns `bun <lib/deck-cli.ts> <args-json>`; `deck-cli.ts` reads the args
on argv, calls `buildDeck` / `manifestFromIrPaths` from the copied deck `lib/*.ts`, and prints a JSON receipt
to stdout (output path, shape count, no-rasterization proof). Copy the s2-agent deck `lib/*.ts` the deck path
needs, with two DSH adaptations: bundle-relative `run.ts` resolution (no `#pi/ext-dir`) and a no-op webui
announce bus. Ship `pptxgenjs` + `marked` as bundle deps.

## Acceptance

- [ ] `archify_export_pptx` registered on `ctx.tools` with the same parameters (`manifestPath | irPaths`, `outputPath`, `theme`, `slidesDir`, `thumbnails`)
- [ ] `lib/deck-cli.ts` (Bun) reads args-json, runs the deck build, and emits a JSON receipt on stdout
- [ ] Deck `lib/*.ts` copied and adapted (no `#pi/ext-dir`; no-op announce bus), `pptxgenjs` + `marked` declared as deps
- [ ] `test/deck-smoke.mjs` runs `deck-cli.ts` on `examples/deck/`, asserting a `.pptx` containing zero `<a:blip>`
- [ ] `thumbnails` and `deck-render` are no-ops or confidently deferred (documented, off by default)
