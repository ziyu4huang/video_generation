---
ticket: 03-emit-pptx
effort: archify-slide-composition
type: task
status: open
created: 2026-08-21
last: 2026-08-21
blocks-on: [01, 02]
blocking: [05]
---
# 03 — `lib/emit-pptx.ts`

> Spec §4.4. Blocks → native shapes and **wrapping** text boxes.

## What to build

`emitPptxSlide(slide: SlideLike, blocks, ctx) => {shapes, texts}`.

- `panel` / `rule` → `addShape("rect"|"roundRect", …)`.
- `text` → `addText(text, { wrap: true, fit: "shrink", … })` — the point of the whole
  effort; never `wrap: false`.
- `bullets` → ONE `addText(TextProps[])` with `bullet`, `indentLevel`, `breakLine`.
- `diagram` → `parseSvg` → `toShapeIR` → `addShapeIrToSlide(slide, ir, boxInInches)`.
  The existing path, unchanged, with a different box.

## Acceptance

- Spy-`SlideLike` test: no `addImage` call ever; every `text` block sets `wrap: true`.
- A `split` slide's diagram box is ~60 % of the content width.
- `<a:blip>` count stays 0 on a built deck (existing property, re-asserted).

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`
