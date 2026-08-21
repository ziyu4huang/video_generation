---
ticket: 03-emit-pptx
effort: archify-slide-composition
type: task
status: closed
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

## Result

**closed 2026-08-21** — `lib/emit-pptx.ts` + `__tests__/emit-pptx.test.ts` (12 tests).

- `SlideLike.addText` was widened to `string | TextRun[]` so one text box can hold a run per
  bullet; `pptx-shapes.ts` still only ever passes a string. The spy slide moved to
  `__tests__/helpers/spy-slide.ts` — importing a test file from another test file silently
  re-runs its suites.
- **`fit: "shrink"` is applied to CONTENT roles only.** Chrome keeps the old options exactly,
  which is what makes a `diagram` slide byte-identical. A silently shrinking action title is
  worse than one `deck-lint` complains about.
- **A real fix the spec did not predict**: emitting `align: "left"` adds `algn="l"` to every
  paragraph — the OOXML default, visually inert, but it broke byte-identity in 4 places per
  slide. `left` is now left implicit.
