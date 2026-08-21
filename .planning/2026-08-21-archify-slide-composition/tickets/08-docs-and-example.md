---
ticket: 08-docs-and-example
effort: archify-slide-composition
type: task
status: open
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
