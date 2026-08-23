---
type: task
status: open
---

# 04 — swap OCR engine: tesseract.js → tesseract-wasm (robertknight)

## Question
Does the file2md OCR path run fully in-process on the standalone
[robertknight/tesseract-wasm](https://github.com/robertknight/tesseract-wasm)
engine (npm `tesseract-wasm`, BSD-2-Clause) — no worker_threads, no runtime
network — behind the unchanged `OcrSession`/`OcrResult` contract?

## What to build
Replace the `tesseract.js` (^7.0.0) worker-based OCR in `src/ocr/ocr.ts` with
`tesseract-wasm`. Same public surface (`OcrSession.recognize`, `OcrResult`,
`normalizeOcrLang`, `imageDims`, `DEFAULT_LANG_PATH`), same
degrade-to-`undefined`-and-notice semantics. Engine: the low-level
in-process `OCREngine` (no Web Worker / no worker_threads — the ADR-0001
flagged Bun fragility disappears). Lang data switches from the `.traineddata.gz`
files tesseract.js gunzips to raw tessdata_fast `.traineddata` (eng + chi_sim),
vendored beside the package under the existing symlink-to-external-store
convention (git-hook binary rule — never blob-commit). The wasm core
(`tesseract-core.wasm`[+fallback]) resolves from the npm package's `dist/`
offline — no fetch, no postinstall download, pixel-parity with today's offline
stance. Degrade order: engine swap is complete BEFORE smart mode's scan-path
relies on real output (sequenced first in the chosen execution order).

## Acceptance
- [ ] Spike (recorded in the ticket's Done note): a rendered PDF page
      (BMP/PNG/BGRA from `src/raster`) feeds the engine and returns text in
      Bun, offline (wasm + `.traineddata` read from disk, zero network) —
      the image-input plumbing under Bun is the crux and must be proven with
      a real run, exactly like the v2 tesseract.js worker spike posture
- [ ] `src/ocr/ocr.ts` swaps engines; `OcrSession`, `OcrResult`,
      `normalizeOcrLang`, `imageDims`, `DEFAULT_LANG_PATH` unchanged in shape
      (hermes-memory consumes `OcrResult`)
- [ ] `tesseract.js`/`tesseract.js-core` removed from `package.json` deps;
      `vendored/ocr-assets/lang` holds raw `.traineddata` (eng, chi_sim);
      `THIRD-PARTY-NOTICES` lists `tesseract-wasm` (BSD-2-Clause) + tessdata_fast
      license
- [ ] Pipeline mocks (`pipeline-v2.test.ts` mocks `../src/ocr/ocr.ts` whole
      module) unaffected — suite green by contract, not by engine
- [ ] `ocr.test.ts` pure parts (dims/lang mapping) and the full package
      canonical `bun run test` green; typecheck + check clean
- [ ] ADR-0001, CONTEXT.md OCR term, SKILL.md updated: stack = tesseract-wasm
      (low-level engine, in-process), lang data = vendored tessdata_fast
- [ ] Degrade-not-fail retained: engine init/recognize failure → `undefined`
      + stderr note, exact v1 contract (no throw)

## Out of scope (state plainly)
- Deploy `copy:`/`vendor:` entries for the wasm trio (`tesseract-core.wasm`,
  `tesseract-core-fallback.wasm`, `tesseract-worker.js`) — same class as the
  pdfium note in ADR-0001; a deploy-flip follow-up, not this ticket.
- Building tesseract-wasm from source (upstream prebuilt dist).
- Quality/accuracy benchmarking of the fast models — old vs new engine
  deviation on real scans is a fog item for the smart effort, not a gate
  here (this ticket ships the mechanism + offline proof).
