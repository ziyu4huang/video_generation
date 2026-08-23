---
ticket: 08-docs-and-example
effort: archify-slide-composition
type: task
status: closed
created: 2026-08-21
last: 2026-08-21
blocks-on: [05, 06, 07]
---
# 08 — README, SKILL, and a composed example deck

## What to build

- `README.md` — the six layouts, the manifest shape, the D3 compatibility rule, the
  `ooxml-lint` gate, and the corrected `Bun.XML` A/B table with its numbers.
- `skills/archify/SKILL.md` — a "compose a deck" section: action titles, one idea per
  slide, 60/40, `takeaway` / `source`. Keep it condensed; depth stays on demand.
- `examples/deck-composed/` — a small manifest exercising all six layouts, reusing the
  existing `examples/deck/ir/*.json` for its diagram blocks.
- `map.md` frontier + ticket statuses synced.

## Acceptance

- `bun run deck examples/deck-composed/deck.config.json` builds clean and lints clean.
- Both example decks pass `ooxml-lint` with zero diagnostics.

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`

## Result

**closed 2026-08-21** — README (six layouts, the D3 rule, the corrected `Bun.XML` A/B table,
the validity section), `skills/archify/SKILL.md` (a condensed "Compose a deck" section with
the five writing rules), and `examples/deck-composed/` exercising all six layouts.

`bun run deck examples/deck-composed/deck.config.json --lint` → 6 slides, 167 KB, 150 native
shapes; content lint clean; ooxml lint clean (40 parts).

Rendered slides were inspected visually in `Bun.WebView` rather than assumed, which is how
the `?embed=1` problem (ticket 04) and the thumbnail ready-signal bug were found: 
`generateThumbnails` waited for an `<svg>` that a composed slide never has, so every composed
slide would have burned the full 3 s timeout. It now accepts `.stage` too.
