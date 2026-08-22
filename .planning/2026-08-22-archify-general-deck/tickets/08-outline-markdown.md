---
ticket: 08-outline-markdown
effort: archify-general-deck
type: task
status: open
created: 2026-08-22
last: 2026-08-22
blocked-by: [02]
---
# 08 — Markdown outline → manifest

> Spec §4.9. Decision D8: an INPUT SHAPE on `archify_export_pptx`, never a third tool.

## What to build

`lib/outline.ts` — `parseOutline(md: string, baseDir: string): DeckManifest`. YAML
frontmatter carries the deck-level fields; the body uses:

| marker | becomes |
|---|---|
| `# H1` | `title` slide; a following `> line` is its `subtitle` |
| `## NN Text` | `section` slide, `sectionNumber` = `NN` |
| `### Text` | content slide, action title |
| `^ text` | `takeaway` |
| `~ text` | `source` |
| `- item` / `  - item` | `bullets` level 0 / 1 |
| `!ir <path>` | `ir`; with bullets ⇒ `split`, without ⇒ `diagram` |
| fenced `:::<name>` + JSON | `layout: <name>` + JSON merged as its slots |

Wire as `outline` / `outlinePath` on `archify_export_pptx` and `--outline` on `bun run deck`.
Both go through the same `resolveDeckInput()` as `manifestPath` / `irPaths` so the four input
shapes cannot drift.

## The design line to hold

The sugar covers **only** the six code layouts — the common case. Every template-driven slide
goes through the fenced JSON payload. Do not grow a marker per template: the dialect then has
to change every time someone drops a file on the search path, which defeats the whole effort.

## Acceptance

- Each marker round-trips to the expected `Slide`.
- `!ir` picks `split` vs `diagram` from the presence of bullets, matching `resolveLayout`.
- A fenced payload naming an unknown layout fails with the registry's "here is what IS
  available" message, not a JSON error.
- Malformed frontmatter / unclosed fence are errors that name the line number.
- The same outline through the tool and through `bun run deck --outline` produces byte-equal
  `.pptx` files.

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`
