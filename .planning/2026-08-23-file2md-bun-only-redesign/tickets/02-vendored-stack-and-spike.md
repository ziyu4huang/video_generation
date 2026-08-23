# 02 — Vendored stack: dsh-cowork core snapshot + OCR assets + spike evidence

**Status: closed (2026-08-23)**

## Task

Bring in the bun-only building blocks and prove the three risky seams before
writing the pipeline.

## Work done

- `vendored/dsh-cowork-core@0.1.0/` — source snapshot of the user's own
  `@dsh-cowork/core` (MIT), LICENSE + VERSION + README beside it. **No
  package.json inside** (isolated-linker lesson: a nested package would not get
  its deps linked; its bare deps are declared by US).
- `vendored/ocr-assets/` — `eng.traineddata.gz` (2.8MB) + `chi_sim.traineddata.gz`
  (1.6MB) from markdown-converter's fast-model set + THIRD-PARTY-NOTICES +
  tesseract licenses.
- Deps (pure JS/wasm): `exceljs@^4.4.0`, `jszip@^3.10.1`, `mammoth@^1.8.0`,
  `pdfjs-dist@^6.0.0`, `tesseract.js@^7.0.0`, `@hyzyla/pdfium@^2.1.13` +
  dev `pdf-lib@^1.17.1`. `mupdf` removed (install-time wasm gone with it).
- `biome.json` excludes `vendored` (pinned snapshot, never reformatted).

## Spike evidence (all offline, bun 1.4.0)

| spike | result |
| --- | --- |
| `bun build --format=cjs` of the vendored core | 298 modules / 3.37MB, executes under node+bun |
| tesseract.js node worker (`worker_threads`) | OCR of a text PNG → exact string |
| pdf-lib image page → pdfium raster → BGRA→BMP → tesseract | full chain → exact string |

## Gate

`bun run check / typecheck / test` (assets + deps pulled; nothing else).

## Fallbacks recorded (ADR risk table)

pdfjs-dist bundling → `vendor: ["pdfjs-dist"]` (unpdf precedent); tesseract
worker under a future Bun regression → `Bun.spawn` bun child; pdfium/`__dirname`
locators → `vendor:` when a deploy flip happens.
