---
ticket: 04-emit-html
effort: archify-slide-composition
type: task
status: open
created: 2026-08-21
last: 2026-08-21
blocks-on: [01, 02]
blocking: [05]
---
# 04 — `lib/emit-html.ts`

> Spec §4.5, decision D4.

## What to build

`emitHtmlSlide(blocks, ctx) => string` — self-contained: one inline `<style>`, no external
asset, `.stage` at `aspect-ratio: 16/9` with `position: relative`, each block absolutely
positioned at its box in `%`. `diagram` → `<iframe>` at the sibling archify artifact.

**D4 is load-bearing**: a `diagram` slide does NOT go through this module. Its
`slide-N.html` remains the archify artifact itself, so the webui Diagram pane's
"full-fidelity and interactive" property is untouched.

## Acceptance

- Output parses as HTML and contains no `http://` / `https://` reference.
- Every block's text appears in the output.
- A `diagram` slide never reaches this emitter (asserted at the orchestrator level).

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`
