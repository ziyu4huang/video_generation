# pi-file2md (v2)

A file→Markdown bridge for pi/s2-agent: convert **PDF, image, DOCX, XLSX, PPTX,
IPYNB, and text files** into structured Markdown a pure-text agent can read —
**entirely bun-only** (no native modules, no macOS toolchain, no Swift, no Python):

- **PDF text layer** — pdfjs-dist, pure TS.
- **Scanned PDFs / images** — vendored pdfium wasm (page raster) + vendored
  tesseract wasm (OCR; eng + chi_sim bundled, fully offline).
- **Office / notebooks** — a vendored `@dsh-cowork/core@0.1.0` snapshot (MIT,
  the user's own project): bounded windows, stable cell/slide addresses,
  zip-bomb + macro rejection, explicit truncation notices.
- **Vision (optional)** — for `mode: vlm`, the local vision-LLM (LM Studio via
  the model-tier config) describes images/scanned pages; text layer and OCR
  are the degrades. No vision server is ever required.

Machine-bound v1 machinery is gone: `mupdf` (postinstall wasm), macOS PDFKit /
pdf2image rasterization, Swift Vision OCR. See
[`docs/adr/0001-vendored-bun-only-stack.md`](docs/adr/0001-vendored-bun-only-stack.md).

## What you get

- `file2md` — the pi tool + `s2-agent cli file2md` command (`<files...> → Markdown`).
- `vision_ask` — lightweight single-image vision-LLM Q&A (no disk pipeline).
- A resumable manifest pipeline: `output/<slug>/{manifest.json, pages/*.md,
  <slug>.md}`; re-runs skip pages already `done`.
- Modes: `auto` (default, text → OCR for scans) | `text` | `ocr` | `vlm`.
- Formats: pdf, image, docx, xlsx, pptx, ipynb, txt, md, csv (→ table), html
  (→ markdown-lite).

## Requires

- Bun (the whole pipeline runs under Bun; nothing else).
- LM Studio serving a vision model at `http://localhost:1234/v1` **only** for
  `mode: vlm` (configured via the model-tier config, `PI_MODEL` legacy alias).
- OCR language data (eng/chi_sim, raw tessdata_fast `.traineddata`) lives in
  the repo's external binary store
  (`../video_generation__models/file2md-ocr-assets/lang/`, the mlx-models
  convention — the 2MB git hook rejects binary blobs, so the lang files are
  **symlinked** into `vendored/ocr-assets/lang/`). On a machine without the
  store, OCR degrades with a notice; `FILE2MD_OCR_LANG_PATH` points anywhere
  the two `.traineddata` files exist. Delete the symlinks and copy real files
  from [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) if you
  need a self-contained copy.

## Examples

```bash
s2-agent cli file2md report.pdf                # text layer, offline
s2-agent cli file2md scan.jpg --extract ocr    # OCR (tesseract, offline)
s2-agent cli file2md deck.pptx --out ./notes
s2-agent cli file2md wb.xlsx
s2-agent cli file2md paper.pdf --extract vlm --scale 3 --lang eng
```

## Bundle for distribution

```bash
bun scripts/build-bundle.ts               # FULL bundle (default) — inline deps
bun scripts/build-bundle.ts --thin        # THIN — peer deps external (self-verify green)
bun scripts/build-bundle.ts --obfuscate   # optional obfuscation pass
```

Output: `../../dist/pi-extensions/pi-file2md.bundle.js` (gitignored). The
self-verify runs the real registration path against the built artifact.

## Internal docs

- `docs/architecture.md` — v2 call chain (sniff → extract → OCR/vision → render).
- `docs/configuring-vision-models.md` — registering vision models /
  `~/.pi/agent/models.json`, tier config.
- `docs/adr/0001-vendored-bun-only-stack.md` — the bun-only vendoring decision.

## Deploy note

The extension is **excluded from the portable s2-agent-sh deploy** (registry
`excludeReason`: vendored OCR assets + optional local vision layer — scope
policy; see `bun-apps/s2-agent/docs/deploy.md` "Limits"). The package structure
is deploy-ready: a future flip only needs `deploy:` block fields + asset copy
entries.
