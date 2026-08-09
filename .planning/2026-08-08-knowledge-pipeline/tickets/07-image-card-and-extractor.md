---
type: grilling
claimed:
blocked by: 06
---
# 07 — Image-card model + extractor

## Question
Images are now in scope (deferred when 02 was decided). Grilling (2026-08-08) chose BOTH OCR + vision-LLM (model google/gemma-4-12b-qat via lm-studio, user-evaluated cheapest/quick), merged into one card.

Pin the image-card contract:
1. Card schema for kind=image: is content = merged (OCR text + vision description)? provenance fields (source_file, format, dimensions, extractor=ocr+vision, content_hash, source_hash, locator)? Reuse 02's provenance front-matter or extend it?
2. Embed strategy: text-embed of merged content (consistent with text pipeline) vs ALSO a CLIP-style image-vector via lm-studio for visual similarity? (DB rule: image-embed, if any, goes in SurrealDB only.)
3. Extractor placement: extend file2md (owns pdf=mupdf; see absorbed file2md effort) with image extraction, or a new extractor module? OCR library pick (tesseract / swift-native / ...)?
4. Chunking: images atomic (one card per image) — confirm, or split multi-panel diagrams?
5. Confirm model id google/gemma-4-12b-qat is available in lm-studio at impl time (recorded verbatim from user eval).

Blocked by 06. Related: 02 (extractor pattern, closed), 04 (embed backend, open).
