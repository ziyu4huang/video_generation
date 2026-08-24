---
name: file2md
description: Convert PDF, image, office, and text files to structured Markdown locally — text-first with bun-only extraction, vendored OCR for scans, optional local vision. Use when the agent must read a PDF/image/docx/xlsx/pptx/ipynb it cannot see, or a scanned document, without uploading it anywhere.
---

# file2md

Local, offline document → Markdown bridge for text-only agents. Every input
converts to editable Markdown that lands under an output dir; nothing is sent
to a network service. Use the bundled runtime, not ad-hoc scripting:

```bash
# dev form (repo root): the `cli` namespace token is required — a bare
# `cli.ts file2md …` falls through to pi's own parser ("Unknown options").
bun bun-apps/s2-agent/src/cli.ts cli file2md ./paper.pdf --out ./vlm-out
# deployed s2-agent:
s2-agent cli file2md ./paper.pdf --extract vlm
# smart: adaptive ladder with figure-page vision enhancement:
s2-agent cli file2md ./spec.pdf --extract smart --scale 3
# as an agent tool (this extension's registered tool — same name):
./s2-agent.sh -p "file2md ./paper.pdf --extract vlm"
```

## Pipeline (mode-selectable)

Everything is text-first: `auto` (default) extracts the text layer and runs
tesseract-wasm OCR only on pages that have no usable text layer (scans). OCR
happens offline (eng + chi_sim language data ships as npm deps,
`@tesseract.js-data/*`). No macOS toolchain, no native npm binaries, no LM
Studio requirement.

| mode | behavior |
| --- | --- |
| `text` | text layer only (never OCR/vision) |
| `ocr` / `auto` | text layer + OCR for thin pages |
| `vlm` | vision-LLM (local, tier-configured) describes thin pages; OCR is the degrade |
| `smart` | adaptive ladder per page: text when usable → OCR when thin → figure pages vision-enhanced (skip notice when no vision server) |

## Smart mode — the adaptive ladder (`--extract smart`)

Per page, `smart` climbs only as far as the page needs (thresholds are named
constants in `src/core/figure.ts` — a drift is a red test):

1. **Text layer** — usable text (≥ `OCR_TEXT_MIN_CHARS`) is used as-is; no rasterization.
2. **OCR** — a thin page (below the text-layer floor) is rasterized and OCR'd exactly as `ocr` mode.
3. **Figure detection** — a **figure page** is a text page whose body is caption-only
   (`Figure N-x.` caption AND body ≤ `FIGURE_MAX_BODY_CHARS` = 1300 — prose pages never
   fit the band, so small inline figures are excluded by construction) or a scan page
   whose OCR output ≤ `FIGURE_OCR_MAX_CHARS` = 200 chars (labels-only).
4. **Vision enhancement** — a detected figure page gets ONE vision-describe call
   (figure-hint prompt variant); the description is **appended** as a
   `## Figure (vision)` section after the untouched original body (never replaces it),
   frontmatter gains `enhanced: vision`, the manifest page record gains
   `figure: { detected: true, enhanced: true }` (additive — schema stays v1).

Degrade semantics — a page never fails because enhancement did not (D4):

- No vision server → one warning line per run; each figure page carries
  `> Figure detected — vision enhancement skipped (no vision server).` with `enhanced: false`.
- Vision call fails / returns empty → the same skip notice, `enhanced: false`, no stored
  page PNG.

Resumability: a done page (status `done` + its page md exists) is **never re-processed** —
re-running `smart` over a finished output re-uses it as-is, including an `enhanced: false`
flag from a no-server run. To re-enhance a page, delete the output dir (or the page
md/png pair) and re-run. `--pages 1,3-5` filters the ladder identically to the other modes.

## Supported inputs

| Format | Read method | Preserved |
| --- | --- | --- |
| PDF (text layer) | pdfjs (pure TS) | searchable text, per-page sections |
| PDF (scanned) | pdfium wasm → tesseract OCR | printed raster text (eng/chi_sim) |
| Image (png/jpg/jpeg/bmp) | tesseract OCR; vision describe under `vlm` | OCR text + source copy |
| Image (webp/gif/tiff) | vision only (`vlm`) | — OCR unsupported for these |
| DOCX | mammoth (pure JS) | paragraphs, lists, links, tables |
| XLSX | exceljs (pure JS) | bounded sheets as markdown tables, cell refs |
| PPTX | OOXML text runs | slide titles/shapes in presentation order |
| IPYNB | JSON cells | markdown/code cells + text outputs |
| TXT / MD | passthrough (capped) | source text |
| CSV | RFC-4180 → markdown table | headers, rows, quoted cells |
| HTML | minimal tag strip → markdown-lite | title, headings, lists, links |

## Bounds and caps (never silent)

- Input ≤ 64 MiB; zip entry/decompressed caps; macro formats (.xlsm/.docm/.pptm)
  and legacy .xls/.doc/.ppt are REJECTED — convert to OOXML first.
- Windows: 20 pages / 200 sheet rows / 1 sheet / 20 slides / 200 cells /
  256 KB of rendered markdown per doc. A `> Truncated:` line always states the
  cut — never claim you read the whole document when the window was capped.
- OCR runs on ≤ 20 pages per PDF; a page with < 8 chars of text layer counts
  as a scan.
- **Caption-only figure pages aren't captured by the text layer.** A born-digital
  spec page whose body is a bare `Figure N-x. …` caption (e.g. `< 900 bytes`) has a
  real text layer — so `mode: vlm`/`ocr` never fire on it — but the diagram itself
  is a vector drawing the text layer cannot read. Such a page is a figure page;
  `--extract smart` detects and vision-enhances it automatically (see the ladder
  above), or describe a one-off with `--extract vlm --pages <list>` if the diagram
  matters and you want the manual path. Do NOT assume a text-layer page captures
  its figures.

## Truth rules

- Never upload files or extracted text to any endpoint; conversion is local.
- Never claim fidelity for layout/fonts/images/formulas/comments/tracked
  changes/animations — state plainly what a format lost.
- OCR output needs proofreading; do not quote mission-critical scanned text
  without noting it came from OCR.
- Never promise pixel-perfect no-loss conversion.

## Completion checklist

- Output path is explicit; source untouched.
- Every page/metadata file exists; manifest.json records statuses.
- Capped/truncated content carries an explicit notice.
- OCR-derived text is marked (page frontmatter `provenance: ocr|text|vision`).
- Caption-only figure pages are flagged in the response (the diagram is not in
  the text layer; `--extract smart` enhances them automatically — with any other
  mode, note which pages to re-run with `--extract smart`).
- Losses stated in the final response; link to the output directory.
