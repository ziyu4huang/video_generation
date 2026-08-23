# s2-agent-ext-file2md

The ubiquitous language of s2-agent-ext-file2md — a file→Markdown bridge that gives a pure-text agent eyes, entirely bun-only and local. Every document kind resolves to a bounded structured read which renders to Markdown; OCR (vendored tesseract wasm) and vision (optional local VLM) layer on top.

## Language

### The bridge

**file2md**:
The file→Markdown bridge (`<files...>` → Markdown) — the pi tool + CLI entry point; reads PDF/image/docx/xlsx/pptx/ipynb/text and writes per-page markdown + manifest + index note.
_Avoid_: converter, OCR-tool (it is a multi-format markdown bridge; OCR is only one layer)

**Pure-text agent**:
The design intent — the consuming agent is text-only; file2md gives it eyes so it never has to "see" a binary file.
_Avoid_: text agent, blind agent

### The pipeline (v2 modes)

**Mode**:
`auto|text|ocr|vlm` — selects how far the per-page extraction goes: text layer only, + OCR for thin pages, or + vision-LLM description (OCR degrade). `auto` converges on `ocr`.
_Avoid_: strategy, feature (a mode is the pipeline's extraction depth)

**Text layer**:
A PDF's embedded text via pdfjs-dist (pure TS) — the cheap, faithful path for born-digital documents. Below `OCR_TEXT_MIN_CHARS` (8) a page counts as a scan.
_Avoid_: OCR (OCR is the raster→text path, not text-layer extraction)

**Provenance**:
Per-page frontmatter marker `provenance: text|ocr|vision` stating which path produced the page body — the reader can always tell OCR text from true text.
_Avoid_: source, extractor (it is a per-page extraction method marker)

**Bounded window**:
The dsh-cowork-core read contract: caps (20 pages / 200 rows / 20 slides / 200 cells / 256 KB) + an explicit `> Truncated:` notice. Silent truncation is the cardinal sin.
_Avoid_: preview, snippet (a window is a bounded, addressed read)

### The layers

**Raster**: 
pdfium (vendored wasm) renders a PDF page to raw BGRA; our pure-TS encoders (`src/raster/{bmp,png}.ts`) turn it into BMP (OCR) or PNG (vision). No PDFKit/pdf2image/ghostscript — that is the v1 machine-bound chain (gone).
_Avoid_: render (it is specifically PDF-page rasterization for OCR/vision)

**OCR**:
The in-process tesseract-wasm engine (robertknight/tesseract-wasm, low-level `OCREngine`, no worker_threads) with raw tessdata_fast eng/chi_sim `.traineddata` vendored beside the package (symlinked into the external binary store) — offline, no network, no Swift Vision CLI. Decode layer: pngjs (PNG) / jpeg-js (JPEG) / our own 24-bit BMP decoder (`src/raster/rgba.ts`) → RGBA. Degrades to `undefined`-and-notice on failure.
_Avoid_: Vision framework, OCR service

**Vision-LLM subagent** (VLM, optional):
The local LM Studio vision model reached through the shared model-tier config — describes thin pages under `mode: vlm`. Its resolution (`resolveVisionLLM`) is the centralized vision-tier resolver shared with flux2/ltx.
_Avoid_: vision API (it is a local optional layer, not a requirement)

### Office / notebook reads

**DSH Cowork core**:
A vendored snapshot of `@dsh-cowork/core` v0.1.0 (MIT, the user's own project) under `vendored/` — sniff-by-magic + zip-family, zip-bomb/macro rejection, bounded windows with stable cell-ref/shape-id addresses, markdown rendering. Vendored per the ext-archify precedent; never edited.
_Avoid_: the upstream dependency (pinned snapshot by design)

**Vault layout**:
`output/<slug>/` — `manifest.json` (resumability, page statuses) + `pages/page-NNN.md` (+ `.png` when rasterized) + `<slug>.md` index note. PDF/image conversions keep it; office/text writes the converted markdown as `<slug>.md` directly.
_Avoid_: export, dist (it is per-document conversion output, not a build artifact)
