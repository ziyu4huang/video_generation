---
type: grilling
status: closed
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

## Resolution (grill closed 2026-08-14)

All 5 decisions settled by the user:

1. **Card schema (kind=image)**: REUSE ticket 02's provenance front-matter, EXTEND with image-specific fields (`format`, `dimensions`, `locator`). `content` = single merged field (OCR text + vision-LLM description) — per the 2026-08-08 grill that chose BOTH OCR + vision-LLM merged into one card.
2. **Embed strategy**: text-embed ONLY of the merged content (consistent with the text pipeline; goes to SurrealDB HNSW). CLIP-style image-vector stays fog/future (would be SurrealDB-only per the DB rule) — do not implement now.
3. **Extractor placement**: EXTEND file2md (owns pdf=mupdf; reuses 02's extractor seam/pattern). OCR library = macOS Vision framework (swift-native), zero new deps.
4. **Chunking**: atomic — one image = one card. Multi-panel splitting stays fog.
5. **OCR bridge**: one-shot standalone Swift CLI invoked via subprocess. embed-mlx-server stays single-purpose; do NOT add OCR to it or touch its LaunchAgent.

Fact item (not a decision): model id `google/gemma-4-12b-qat` availability in lm-studio to be verified at impl time by the implementer (the ticket Question already required this).

closed: 2026-08-14 (image-card contract pinned — 02-front-matter + image fields, merged content, text-embed only, file2md + Vision OCR via one-shot Swift CLI, atomic cards; impl now plannable)
