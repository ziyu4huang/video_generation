---
type: task
status: open
---

# 01 — smart mode plumbing + figure detection (no vision)

## Question
Does `--extract smart` run the adaptive ladder with figure detection and degrade cleanly —
flagging, never failing — when no vision server is present?

## What to build
`--extract smart` parses and runs the pipeline end-to-end with vision absent: per PDF page the
text layer is extracted first; a usable text page is checked for the caption-only-figure shape
and either done as `provenance: text` (not a figure) or figure-flagged with the skip notice
(figure). A thin page rasterizes and OCRs as today, with the OCR-length band deciding the
figure flag. Figure decisions land in the manifest page record (`figure: { detected,
enhanced: false }`) and the page frontmatter gains nothing yet (no enhancement without
vision). A prose page with an incidental `Figure` mention never rasterizes and never flags.
Vision resolution is attempted softly: no server → one warning line, run continues. All
existing modes stay byte-for-byte unchanged.

## Acceptance
- [ ] `parseMode("smart")` returns `smart`; the CLI help text lists `--extract smart`
      (auto|text|ocr|vlm|smart) with an example
- [ ] Smart run over a caption-only-figure fixture PDF with no LM Studio: figure page md
      carries `> Figure detected — vision enhancement skipped (no vision server).` and the
      manifest records `figure: { detected: true, enhanced: false }`; the run completes with
      the doc_done emit, no throw
- [ ] A prose page whose body mentions `Figure` inline (body above the band) is NOT
      figure-flagged and never rasterizes (ladder-order assertion)
- [ ] A thin page in smart mode still OCRs exactly as in `ocr` mode (existing mock contract:
      OCR text recorded with `provenance: ocr`)
- [ ] Detector unit tests pass at band boundaries (caption regex variants; 1299/1300/1301
      chars; OCR band 199/200/201 chars)
- [ ] Existing-mode tests (auto/ocr/vlm/text) remain green — no behavior change
