# adaptAutoMemoryMarkdown

- **type:** implementation detail
- **origin:** pi-knowledge-graph-closed-loop.md

Transformation logic for auto-memory Markdown files during ingestion.

## Changes

1. **Harvests body `#hashtags`** — not just `[[wiki-links]]`
2. **Strips `[[...]]` brackets** from the detail body (keeps prose)

## Rationale

Memory `[[links]]` reference sibling memory by **bare slug**, but cards are **namespaced** (`auto-memory-<slug>.md`) and slugified (`.` → `-`). Raw body links are mostly **dead**. Graph edges live in `## 連結` (shared-tag), not prose; the tag harvest drives those edges.

## References

- [[auto-memory-bulk-extraction]]
- [[latent-bugs-fixed]]

## 連結
- #markdown #transformation #hashtags #wiki-links #namespacing
