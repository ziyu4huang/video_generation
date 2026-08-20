---
ticket: 04-pptx-mapper
effort: archify-view-pptx-bun
type: task
status: open
created: 2026-08-21
blocks-on: [03]
blocking: [05]
---
# 04 — archify: `lib/pptx-shapes.ts` (ShapeIR → pptxgenjs primitives)

> Spec §4.2. Decision D1.

## Goal

Emit real, editable PowerPoint shapes. No image ever reaches a slide.

## What to build

`addShapeIrToSlide(slide, ir: ShapeIR, box: {x,y,w,h})` — `box` in inches. Uniform scale
`s = min(box.w/ir.width, box.h/ir.height)` with centering (aspect preserved).

Mapping table (spec §4.2): `rect`+`rx` → `roundRect`; `rect` → `rect`; `ellipse` → `ellipse`;
`polygon` → `custGeom {close:true}`; 2-point straight `path` → `line` (+ native
`endArrowType` when a `marker-end` is referenced); any other `path` → `custGeom` with
`Q`→`curve:{type:"quadratic"}`, `C`→`cubic`, `A`→`arc`. `text` → `addText` with a box derived
from `anchor` + `fontSize`, `align` from `anchor`.

Notes:
- `pptxgenjs@4.0.1` `custGeom` point curve support is verified in its bundled
  `types/index.d.ts` — quadratic/cubic/arc + `close`.
- Arrowheads: archify puts `<marker><polygon>` in `<defs>` referenced via `marker-end`.
  Simple connectors stay ONE editable line via `endArrowType`; multi-segment routes emit the
  arrowhead as its own `custGeom` at the computed terminal angle.
- Text boxes come from anchor geometry, not glyph metrics (accepted; fallback charted in
  `map.md` fog).

## Acceptance

- Unit tests assert the emitted pptxgenjs call sequence per ShapeIR kind (spy on a fake
  slide), including that `addImage` is **never** called.
- Scale/centering is exact for a non-16:9 ShapeIR (no stretch).

## Gate

`( cd bun-apps/pi-agent-ext-archify && bun run typecheck && bun run test )`
