# Spec — file2md v2: bun-only, text-first, vision-optional

## 1. Problem restated

v1's file→markdown bridge could not be installed or run anywhere this machine
isn't: `mupdf`'s wasm is fetched at install time, PDF page images come from
macOS PDFKit (via an embedded Swift source) or `pdf2image`, OCR comes from a
Swift-built binary, and every interesting conversion required LM Studio on
localhost. The references (markdown-converter, dsh-cowork) show a better shape:
**pure-TS/JS extraction with bundled wasm OCR**, all local.

## 2. Design

### 2.1 Document model

Every input resolves to a sniffed `FileKind` (content beats extension):

| kind | read | notes |
| --- | --- | --- |
| `pdf` | pdfjs text layer (per-page lazy) | pages < 8 chars = scan |
| `image` | OCR / vision describe (per format) | png/jpg/jpeg/bmp OCR-able |
| `docx`/`xlsx`/`pptx`/`ipynb` | vendored dsh-cowork `readDocument` | bounded windows, stable addresses |
| `text` | passthrough (txt/md) / csv→table / html→markdown-lite | capped with notice |

### 2.2 Extraction depth (mode)

- `text` — extraction only. Never OCR/vision. Images rejected with a message.
- `ocr` / `auto` — text layer first; thin pages raster (pdfium) + OCR (tesseract wasm, vendored eng/chi_sim).
- `vlm` — same as `ocr`, except thin pages go to the VLM (profile classify on page 1 too, when not forced); any VLM failure degrades to OCR, then to an explicit notice.

### 2.3 Provenance and honesty

- Per-page frontmatter `provenance: text|ocr|vision` — a reader always knows the source.
- Degraded layers always produce a stderr note and/or a `> …` notice; never a silent empty page.
- Caps mirror dsh-cowork defaults (64MiB input, 20 pages, 200 rows, 20 slides, 200 cells, 256KB markdown); truncation is explicit.

### 2.4 Layout contract (unchanged from v1)

`output/<slug>/` = `manifest.json` (page statuses — pdf-to-vault stage-1 resume),
`pages/page-NNN.md` (+`.png` only when the vision path rasterized), `<slug>.md`
index note (MOC for pdf/image; the converted markdown itself for office/text).

### 2.5 Modes of operation (surfaces)

- Tool `file2md`: params `input, out, model, provider, thinking, type, mode(auto|text|ocr|vlm), pages, scale, relpath, concurrency, lang, note, knowledge` (v1 `extract`/`dpi`/`mode`-as-note-style removed).
- CLI `s2-agent cli file2md`: `--extract` (new values), `--note`, `--lang`, `--scale` (float 0.1–16), `--pages`, `--out`, `--type`, model flags, `--mode json` unchanged.

## 3. Decisions D1–D6 (rationale)

| D | decision | why |
| --- | --- | --- |
| D1 | vendor dsh-cowork core snapshot (no package.json inside) | archify precedent; isolated-linker phantom hygiene means the snapshot must not be a nested package; its bare deps get declared by us |
| D2 | pdfium wasm + own BMP/PNG encoders | only bun-only raster option; encoders are ~60 lines each, deterministic |
| D3 | vision optional, tier-based | `resolveVisionLLM` already central (f5b81c85); text/ocr modes must never require a model |
| D4 | keep tool/gate/knowledge/manifest surfaces | pdf-to-vault (stage-1 resume), hermes-memory (`extractImageCard`, `OcrResult`), webui/knowledge-card integrations must not break |
| D5 | png only for vision pages | honest manifest, less disk |
| D6 | `--extract` reuses its value space | `--mode` is the CLI output mode — collision would ripple through the arg parser |

## 4. Out of scope

Markdown→anything (hub model); webp/gif/tiff OCR; handwriting/layout fidelity;
shipping file2md in the portable deploy (exclusion preserved — a config-only
future flip per ADR).

## 5. Verification (measured)

- `bun run check / typecheck / test` in the package: biome clean (vendored excluded), 196 tests green incl. real pdfium raster, mocked-boundary pipeline e2e.
- s2-agent package: typecheck green; `cli-argv` + e2e arg-validation (scale) green; manifest regenerated (26 extensions).
- devops: deploy-report + scripts-dir-contract tests green (excluded table intact with the new reason).
- Real smoke via the exact CLI code path: born-digital text pdf (provenance text), scanned pdf (real OCR → "FILE2MD OCR SPIKE 12345"), xlsx (cell-ref table) — all three manifest'ed.
