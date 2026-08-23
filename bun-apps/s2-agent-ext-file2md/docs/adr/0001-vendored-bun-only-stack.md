**ID:** `ADR-file2md-0001` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID.

# file2md v2 is a bun-only, vendored-snapshot stack (no machine-bound deps)

**Status:** accepted (2026-08-23; effort `.planning/2026-08-23-file2md-bun-only-redesign`, decision D1/D2)

file2md v2 does document→Markdown with **zero native/CLI/Swift machinery**: pure-TS
extraction (pdfjs text layer + vendored dsh-cowork-core office windows), vendored
tesseract-wasm OCR (offline, eng/chi_sim), vendored pdfium wasm page rasterization,
and a single pure-TS BMP/PNG encoder we own (`src/raster/{bmp,png}.ts`). The mupdf
npm package (wasm downloaded at install — machine-bound), the macOS PDFKit/pdf2image
rasterizers, and the Swift Vision OCR binary are all gone. Vision (LM Studio via the
model-tier config) is an optional layer behind `mode: vlm`, never a prerequisite.

## Considered options

- **Vendored @dsh-cowork/core@0.1.0 snapshot (MIT, user's own project) under `vendored/`**
  ✅ — the ext-archify precedent: pinned snapshot, LICENSE + VERSION + README beside
  the source, no dependency on the upstream source after vendor-copy. Its pure-JS deps
  (exceljs, jszip, mammoth, pdfjs-dist) are ordinary package deps — bundler-safe,
  proven by a cjs `bun build` spike (298 modules).
- **Adopt markdown-converter's runtime wholesale** — rejected: it rolls with
  `@napi-rs/canvas` (a Rust native module) + ~60MB of OCR/font assets and is
  Node-oriented; it is the reference for the *design* (format matrix, local-only,
  artifact verification), not the stack.
- **Keep mupdf + VLM-first pipeline** — the v1 design; rejected because mupdf's
  wasm is postinstall-downloaded (breaks relocatability/offline install) and the
  whole pipeline required a localhost vision server or a Mac toolchain.
- **Text-only, no OCR** — rejected by the user: scanned PDFs/images need offline
  OCR, hence the vendored tesseract lang data (eng + chi_sim, ~4.4 MB, fast models).

## Consequences

- **The excludeReason in the deploy registry changes** — "mupdf native/wasm + hard
  LM Studio" becomes a lighter, honest scope reason (vendored OCR assets + optional
  local vision; deploy-ready structure, still excluded by policy until shipped).
- **Local beats bundled.** `vendored/` dirs are excluded from biome/tsconfig; assets
  resolve beside the package at dev time. The lang data files are **symlinks**
  into the repo's external binary store (`../video_generation__models/
  file2md-ocr-assets/`, the mlx-models convention — the 2MB git hook rejects
  binary blobs, and the hook even documents the symlink pattern); OCR degrades
  with a notice when the store is absent, and `FILE2MD_OCR_LANG_PATH` overrides.
  A future deploy flip will need `copy:`/`vendor:` entries: pdfium-wasm and
  @hyzyla/pdfium locate their .wasm via `__dirname`/`import.meta.url`, which
  bun's cjs bundling rewrites to build-machine paths — the same pitfall that
  made web-access vendor unpdf.
- **In-process OCR engine — no worker_threads.** The engine is robertknight/
  tesseract-wasm's low-level `OCREngine` (npm `tesseract-wasm`, BSD-2-Clause):
  the bundled wasm core (`tesseract-core.wasm` from `dist/`) + raw tessdata_fast
  `.traineddata` load off disk and recognition runs synchronously in-process.
  Verified 2026-08-23 under Bun 1.4: raster (pdfium via `rasterPage`) → RGBA →
  text on both the PDF-scan (BMP) and image-file (PNG/JPEG) paths, offline
  (smoke: `OcrSession.recognizePdfPage` + CLI `file2md <png> --extract
  ocr`). tesseract.js (worker_threads under Bun) is gone, so the
  "Bun.spawn fallback if worker_threads regresses" question no longer applies.
  Models: raw `eng`/`chi_sim` `.traineddata` (tessdata_fast, ~6.6 MB total)
  replace the earlier `.traineddata.gz` + gunzip-cache convention.
- **Heavier bundle** (~4.5 MB thin) — accepted: the package is excluded from the
  portable tree; the weight buys full local document coverage.
