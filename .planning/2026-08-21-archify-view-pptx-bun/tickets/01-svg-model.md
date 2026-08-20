---
ticket: 01-svg-model
effort: archify-view-pptx-bun
type: task
status: open
created: 2026-08-21
blocking: [03]
---
# 01 — archify: `lib/svg-model.ts` (HTMLRewriter → ordered node list)

> Spec §4.1. First half of the ShapeIR seam. Decision D2.

## Goal

Turn a rendered archify `.html` into an ordered, transform-resolved node list — the only
place in the codebase that knows SVG-as-markup.

## What to build

`parseSvg(html: string): SvgDoc` in `bun-apps/pi-agent-ext-archify/lib/svg-model.ts`:

1. ONE `HTMLRewriter` pass, `.on("svg, svg *")`, over the whole HTML string — do NOT
   pre-slice the `<svg>` out with string search.
2. Maintain a depth stack: push on `element`, register `e.onEndTag(() => depth--)` only when
   `!e.selfClosing` (SVG self-closing tags are honored by the HTML5 foreign-content rules —
   measured correct on the sample artifact).
3. Per node record `{ tag, attrs, depth, text, ctm, defOnly }`:
   - `attrs` keys are **lowercased by HTMLRewriter** — normalize every read through one
     documented helper. `viewBox` arrives as `viewbox`, `markerWidth` as `markerwidth`.
   - `ctm` = 2×3 matrix composed down the ancestor `<g transform>` chain (support
     `translate`, `scale`, `rotate`, `matrix`).
   - `defOnly` = true for any node inside `<defs>` (retained and addressable, never painted).
4. `SvgDoc` also carries `{ width, height }` parsed from `viewbox` (fall back to
   `width`/`height` attributes).

## Acceptance

- Against the committed `ir/pi-agent-ext-webui-v31.architecture.html`: **exactly 359 element
  nodes**, in document order, nesting depths correct, `<text>` content captured.
  (Independent census baseline: 99 text, 88 rect, 73 g, 48 path, 22 title, 14 circle,
  4 marker, 4 polygon, 3 ellipse, 1 each svg/desc/defs/pattern.)
- `doc.width === 1450 && doc.height === 726` for that artifact.
- Node order across DIFFERING sibling tags is preserved (the property `Bun.XML` measurably
  loses — assert it explicitly so nobody "optimizes" the parser back).

## Gate

`( cd bun-apps/pi-agent-ext-archify && bun run typecheck && bun run test )`
