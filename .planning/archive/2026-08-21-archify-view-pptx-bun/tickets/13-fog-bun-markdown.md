---
ticket: 13-fog-bun-markdown
effort: archify-view-pptx-bun
type: decision
status: open
created: 2026-08-21
---
# 13 — fog: is `Bun.markdown` worth dropping `marked`?

> Deliberately OFF the main line. Do not start this before tickets 01–12 are closed.

## Question

Bun 1.4 ships `Bun.markdown` (`.html()`, `.react()`). Both packages depend on `marked`:

- `pi-agent-ext-webui/src/render-markdown.ts` — 12 lines, a thin wrapper. Low risk.
- `pi-agent-ext-archify/lib/architecture-render.ts` — 331 lines that build a **bespoke block
  model on marked's tokenizer** (`tokenToBlock`, caption attachment, custom inline renderer)
  and are pinned by `__tests__/fixtures/architecture-render.golden.html`. `Bun.markdown`
  exposes rendered HTML, not a token stream, so this is a rewrite, not a swap.

## Why it is fog

Dropping one shared dependency does not justify rewriting a golden-pinned renderer. The webui
half may well be worth doing alone.

## What would close it

Measure: does `Bun.markdown` expose (or can we reconstruct) enough structure for
`architecture-render.ts` without changing the golden output? If no — close as
**won't-do for archify**, and decide the webui half on its own merits.
