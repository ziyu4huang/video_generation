---
name: file2md
description: Convert PDF, image, office, and text files to structured Markdown locally — text-first with bun-only extraction, vendored OCR for scans, optional local vision. Use when the agent must read a PDF/image/docx/xlsx/pptx/ipynb it cannot see, or a scanned document, without uploading it anywhere.
---

# file2md

Local, offline document → Markdown bridge for text-only agents. Every input
converts to editable Markdown that lands under an output dir; nothing is sent
to a network service. Use the bundled runtime, not ad-hoc scripting:

```bash
# dev form (repo root):
bun bun-apps/s2-agent/src/cli.ts file2md ./paper.pdf --out ./vlm-out
# deployed s2-agent:
s2-agent cli file2md ./paper.pdf --extract vlm
# as an agent tool (this extension's registered tool — same name):
./s2-agent.sh -p "file2md ./paper.pdf --extract vlm"
```

## Pipeline (mode-selectable)

Everything is text-first: `auto` (default) extracts the text layer and runs
vendored tesseract-wasm OCR only on pages that have no usable text layer
(scans). OCR happens offline (eng + chi_sim language data is bundled). No
macOS toolchain, no native npm binaries, no LM Studio requirement.

| mode | behavior |
| --- | --- |
| `text` | text layer only (never OCR/vision) |
| `ocr` / `auto` | text layer + OCR for thin pages |
| `vlm` | vision-LLM (local, tier-configured) describes thin pages; OCR is the degrade |

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
- Losses stated in the final response; link to the output directory.
