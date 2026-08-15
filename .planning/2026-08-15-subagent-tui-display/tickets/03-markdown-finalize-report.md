---
type: task
status: open
blocking: 02
---
# 03 — Markdown finalize: settled expanded report

## Question

How does the settled finalize REPORT render as styled markdown matching host chat?

## What to build

- The settled expanded branch returns a `Container` composed of the existing header row (badge + model/elapsed/tags meta, content unchanged) followed by a `Markdown` component fed the full report text and the shared markdown theme (`getMarkdownTheme()`), mirroring host chat's custom message rendering — headings, bold, emphasis, code, theme colors instead of raw `##` and `**` markers.
- The full, uncapped report body renders in the expanded view, wrapping and re-flowing at terminal width.
- Streaming partials stay plain capped text exactly as today — the flicker regression (#1104) is preserved; the markdown change is confined to the settled expanded branch.

## Acceptance

- [ ] Rendered lines carry heading/bold theme codes.
- [ ] Full report body present (uncapped) in the expanded view.
- [ ] Streaming branch byte-compatible plain capped text.
- [ ] Header row shape unchanged.
