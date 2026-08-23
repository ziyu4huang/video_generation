---
type: task
blocking: 01
status: open
---

# 02 — vision enhance on figure pages

## Question
When a vision LLM is available, does smart mode describe figure pages and append the
description as a clearly marked section — on both text-layer and scanned figure pages?

## What to build
Figure-flagged pages in smart mode get a vision describe call with a figure-specific prompt
hint ("describe the diagram/figure on this page"). The description appends as
`## Figure (vision)` after the untouched original body; page frontmatter gains
`enhanced: vision`; the manifest figure record flips `enhanced: true`. The scan path completes
the ladder: thin page → OCR (existing) → OCR-length figure check → vision describe appended to
the OCR body. Vision failures — network error, retry exhaustion, or the #1913 empty-output
guard rejecting the result — degrade to the ticket-01 skip notice with `enhanced: false`; the
page still completes. Vision calls run under the existing per-document concurrency pool; a
text figure page rasterizes exactly once, only when enhancement can actually run.

## Acceptance
- [ ] Figure-caption fixture page + mocked vision LLM: the vision call receives the
      figureHint prompt variant; page md contains the original body followed by
      `## Figure (vision)`; frontmatter `enhanced: vision`; manifest
      `figure: { detected: true, enhanced: true }`
- [ ] Scan-shaped fixture (thin text layer) + short mocked OCR output → vision called; long
      mocked OCR output → vision NOT called
- [ ] Mocked vision returning empty/rejected (guard path) → skip notice present, page
      `status: done`, `enhanced: false` — never a page failure
- [ ] Prose pages and non-figure pages never invoke the vision LLM (call-counter assertion)
- [ ] Soft-resolve unit test: smart mode with the vision leaf throwing resolves to
      llm-undefined and continues (ticket-01 behavior intact)
