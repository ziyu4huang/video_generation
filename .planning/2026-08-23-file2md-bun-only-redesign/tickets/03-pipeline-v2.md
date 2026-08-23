# 03 — Pipeline v2: sniff → extract → OCR/vision on demand → manifest

**Status: closed (2026-08-23)**

## Task

Replace the machine-bound v1 pipeline (`classifyKind → PDFKit rasterize → VLM
explain`) with the text-first v2 pipeline layered on the new stack.

## Work done

- `src/core/types.ts` — `FileKind`, `File2mdMode`, `PageNoteStyle`, caps
  (dsh-cowork parity), `File2mdPipelineOptions`.
- `src/core/sniff.ts` — `detectKind`: image magic (8 formats) → dsh-cowork doc
  family (pdf/OOXML/ipynb, macro + ole2 rejections) → text family; content
  always beats extension.
- `src/core/pdf-text.ts` — pdfjs-dist legacy, worker-free; lazy per-page text.
- `src/raster/{bmp,png,pdf}.ts` — pdfium singleton (`loadPdfium`, degrade to
  undefined) + own BMP (node-free) and PNG (node:zlib + CRC32) encoders.
- `src/ocr/ocr.ts` — `OcrSession` (one worker per document; lang normalized at
  construction — the worker requests `lang.traineddata.gz` VERBATIM, `en` is
  ENOENT until normalized), `ocrImageFile`, `imageDims` (header parsing).
- `src/pipeline.ts` — `runFile2mdPipeline`: modes text/ocr/vlm (auto≡ocr),
  per-page `provenance`, resume/manifest/`pageLabel` contract intact, office via
  vendored `readDocument` + `renderMarkdown`, csv→table + html→markdown-lite
  with cap notices, `runPool`/`parsePageSpec`/`parseMode` kept/public.
- Deleted: `src/native/*` (mupdf, pdf2png), `src/image/ocr.ts` (Swift), `vlm/{extract-strategy,figure-annotate,figure-detect,page-context}.ts`.
- `src/image/extract-image.ts` — default OCR now `ocrImageFile` (API + `OcrResult`
  unchanged for hermes-memory).
- `src/index.ts` — v2 export set (extends beyond the pipe: core/raster/ocr).

## Gate

196 package tests green (incl. mocked-boundary pipeline e2e + real pdfium
raster + encoders roundtrip + sniff matrix + office windows + csv/html).
Typecheck + biome green.
