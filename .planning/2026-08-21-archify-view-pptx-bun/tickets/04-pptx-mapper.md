---
ticket: 04-pptx-mapper
effort: archify-view-pptx-bun
type: task
status: closed
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

## Result

**closed 2026-08-21** — `lib/pptx-shapes.ts` + `__tests__/pptx-mapper.test.ts` (25 tests
against a spy slide, including an explicit "addImage is NEVER called, for any node kind").

Three pptxgenjs semantics were **measured, not assumed** (probed by generating a .pptx and
reading its XML):
- `custGeom` `points` are relative to the shape's own x/y, because pptxgenjs emits
  `<a:path w= h=>` equal to the shape box. Every path therefore gets its own bbox with
  points rebased onto it.
- `rectRadius` is a fraction 0-1 (`adj val = r * 100000`), not a length.
- `line.width` is in points while x/y/w/h are inches.
