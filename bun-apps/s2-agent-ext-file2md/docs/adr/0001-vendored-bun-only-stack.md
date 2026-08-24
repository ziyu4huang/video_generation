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

## Amendment 2026-08-24 — OCR lang data source: external store → npm

Every runtime asset is now npm-sourced so `bun install` alone covers a
network-limited host (no external binary store, no web fetch at runtime).
`tesseract-wasm`'s `dist/tesseract-core.wasm` and `@hyzyla/pdfium`'s
`pdfium.wasm` already shipped inside their npm tarballs; the remaining gap was
lang data:

- **Old**: git-tracked symlinks `vendored/ocr-assets/lang/{eng,chi_sim}`
  → `../video_generation__models/file2md-ocr-assets/lang/` (raw
  tessdata_fast@main). Machine-bound absolute paths — dangled on any other
  host, and `vendored/` could not hold real files (2 MB git hook).
- **New**: `@tesseract.js-data/eng@1.0.0` + `@tesseract.js-data/chi_sim@1.0.0`
  (npm, MIT wrapper; traineddata from tesseract-ocr/tessdata, Apache-2.0);
  pinned exact. `src/ocr/ocr.ts` resolves the gz via
  `require.resolve("@tesseract.js-data/<part>/package.json")` →
  `4.0.0_best_int/<part>.traineddata.gz`, gunzips in-process, caches per part.
- **Model set deliberately swaps**: tessdata_fast@main → tessdata 4.0.0
  best-int (tesseract.js's default integerized set; eng ~5.2 MB / chi_sim
  ~2.5 MB decompressed) — NOT byte-identical to the previous refs. Quality gate
  = the live engine tests + the deploy-e2e `file2md-ocr` probe. Fallback pin if
  a regression shows up: `4.0.0/` (standard).
- **`FILE2MD_OCR_LANG_PATH` was doc-only and is now implemented**: raw
  `.traineddata` dir override (external-store / custom copies still work).
- The old ".traineddata.gz + gunzip-cache" convention is intentionally
  reinstated (npm ships gz), superseding the raw-file convention of the base
  decision.
- Deploy: `registry-config.ts` file2md entry drops `copy: ["vendored/ocr-assets"]`
  and adds both `@tesseract.js-data` packages to `vendor:`.

## Amendment 2026-08-24 (b) — accuracy re-verification: the "swap" was sourcing-only, and multi-lang was silently broken

Observed verdict, 2026-08-24, on a real bilingual sample (rendered CN+EN page
→ PNG + image-only PDF; source files under `/tmp`, method + output recorded
below). **Model-set verdict: keep `4.0.0_best_int`.**

- **The "swap" was NOT a model change — it was sourcing-only.** SHA-256 of
  the npm `4.0.0_best_int/*.traineddata.gz` == the external store's
  `.traineddata.gz` (eng `45b4cb34…`, chi_sim `b8a23f10…`, byte-identical),
  and the OCR output of the npm set matches the old fast refs error-for-error
  (`综述`→`红述`, `迭代`→`欠代` in both). The change was the *source of
  shipping* (machine-bound store → npm install); the "deliberately swaps"
  framing in amendment (a) was wrong. The store's *raw* (ungzipped) files
  differ by hash but are quality-equivalent on the sample — both share the
  same residual model limits. **Fallback pin `4.0.0/` (standard) was
  exercised**: it reads `综述`/`迭代` correctly but misreads `0.001`→`0.0001`
  and costs ~11× chi_sim gz size (20.2 MB vs 1.7 MB) — mixed trade-offs, not
  a regression to fix.
- **Real bug found (this is the regression the probe was designed to catch):
  multi-lang silently degraded to eng-only.** tesseract-wasm's `OCREngine`
  keeps only the FIRST loaded model (upstream `LoadModel` → single-engine
  `Init`; a second call is inert); `OcrSession` looped `loadModel` over
  "eng+chi_sim", the second call was silently ignored, and the output was
  byte-identical to eng-only — Chinese text came back as Latin junk
  (`#5 2%` for `第 2 章`). The v1 smoke tests (English fixture), `init()`
  "eng+chi_sim" (only asserted the load loop didn't throw) and the
  deploy-e2e probe could not see it.
  **Fix:** multi-part langs run one pass per part (one engine per part, each
  with its own model) and merge lines — match boxes by vertical-center
  tolerance PLUS a horizontal-overlap requirement, per matched line pick the
  pass whose text contains Han unless the other side read it confidently
  (≥ 0.5); split-row boxes from one pass are deduped; Han-Han spaces from
  chi_sim spacing are collapsed; single-part path unchanged.
- **Pins (must fail pre-fix — verified):** pure merge-logic unit tests (incl.
  the measured trap line: correct Chinese at chi_sim confidence 0.00 vs eng
  garbage at 0.21 — naive max-confidence picks the garbage) + a live
  `eng+chi_sim`-order test over a rasterized bilingual PDF (pdf-lib +
  macOS Arial Unicode — the only CJK-capable font reachable without committing
  a binary fixture; darwin-only, skipped when absent) asserting Chinese
  content (`第 2 章`) AND exact English. An all-Latin prose fixture was tried
  first and rejected: chi_sim reads it byte-identically to eng, so it could
  not discriminate (and pre-fix `chi_sim+eng` is the NON-poison order — the
  poison order is `eng+chi_sim`).
- Post-fix, eng+chi_sim on the bilingual page returns correct Chinese + exact
  English (image path and raster→OCR PDF path both, `provenance: ocr`).
  Known residual model limits (not regressions — present in old fast too):
  `综述`→`红述`, `迭代`→`欠代`, `0.001`→`0001`, chi_sim's English slightly
  less precise than eng's (the merge picks eng for English lines).
- **`FILE2MD_OCR_LANG_PATH` was doc-only and is now implemented**: raw
  `.traineddata` dir override (external-store / custom copies still work).
- The old ".traineddata.gz + gunzip-cache" convention is intentionally
  reinstated (npm ships gz), superseding the raw-file convention of the base
  decision.
- Deploy: `registry-config.ts` file2md entry drops `copy: ["vendored/ocr-assets"]`
  and adds both `@tesseract.js-data` packages to `vendor:`.
