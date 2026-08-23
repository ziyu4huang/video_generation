# PRD — s2-agent-ext-file2md (v2)

## Problem

Pure-text agents cannot read binary/visual files. v1 solved this with a
machine-bound chain: mupdf (wasm downloaded at install), macOS PDFKit/pdf2image
rasterization, a Swift Vision OCR binary, and a hard LM Studio vision
dependency — none of it portable, none of it installable offline. The converted
output must come from a **bun-only** stack: local, offline, no native code, no
external CLI.

## Solution

A file→Markdown bridge for pi/s2-agent where every kind (pdf, image, docx,
xlsx, pptx, ipynb, txt/md/csv/html) resolves to a **bounded structured read**
and renders to Markdown. Text-first: the PDF text layer (pdfjs, pure TS) and
office windows (vendored dsh-cowork-core) are the deterministic base; scanned
pages and images get offline OCR (vendored tesseract wasm, eng/chi_sim) via
pdfium-wasm page raster; the vision-LLM (local, tier-configured) is an OPTIONAL
layer behind `mode: vlm`. Bundled OCR assets + wasm cores make the whole
pipeline work with zero network and zero native builds.

## Architecture

```
input (pdf|image|docx|xlsx|pptx|ipynb|text)
  └─ detectKind()               MECHANICAL magic bytes + zip family + peek   [core/sniff]
       ├─ pdf ── openPdf()      pdfjs text layer (pure TS)                   [core/pdf-text]
       │     └ thin page → rasterPage() (pdfium wasm, pure BMP/PNG encoders) [raster]
       │           ├ mode ocr/auto → tesseract OCR (vendored lang data)      [ocr]
       │           └ mode vlm     → vision-LLM describe (degrade → OCR)
       ├─ image ── OCR (+ optional vision describe); source copied into pages
       ├─ office ── readDocument() vendored dsh-cowork-core bounded windows  [vendored]
       └─ text   ── passthrough / csv→table / html→markdown-lite (capped)
  ⇒ manifest.json (resumable) + pages/*.md (+ .png when rasterized) + <slug>.md
```

## Modes

- **auto / ocr** (default): text layer, OCR for pages with < 8 chars.
- **text**: extraction only — never OCR/vision.
- **vlm**: vision-LLM describes thin pages; OCR is the automatic degrade.

## Requirements

- **R1 — bun-only**: no native npm, no Swift/PDFKit/pdf2image, no postinstall
  downloads. Verified by package deps (exceljs, jszip, mammoth, pdfjs-dist,
  tesseract.js, @hyzyla/pdfium, pdf-lib — pure JS/wasm).
- **R2 — offline**: OCR lang data + wasm cores in-package; no network at any
  conversion step. `mode: vlm` is the sole optional server touch.
- **R3 — bounded**: 64 MiB input, zip-bomb/macro guards, 20-page/200-row/
  20-slide/200-cell windows with explicit truncation notices.
- **R4 — honest provenance**: per-page `provenance: text|ocr|vision`; OCR output
  marked; degraded layers produce notices, never silent misses.
- **R5 — stable surfaces**: `file2md` tool + `s2-agent cli file2md`, `vision_ask`,
  manifest/slugify contract for `pdf-to-vault` stage 1, `pi:knowledge` emission.
- **R6 — deploy exclusion preserved**: stays out of the portable s2-agent-sh
  tree (scope policy), with deploy-ready package structure.

## Out of scope (v2)

- Scanned-document pixel fidelity, handwriting, exact table/equation recovery.
- WebP/GIF/TIFF OCR (vision path only, when present).
- Markdown → PDF/DOCX/XLSX outputs (the markdown-converter hub model); v2 is
  read-only conversion to Markdown.
