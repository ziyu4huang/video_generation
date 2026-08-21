---
ticket: 05-deck-build-rewrite
effort: archify-slide-composition
type: task
status: closed
created: 2026-08-21
last: 2026-08-21
blocks-on: [02, 03, 04]
blocking: [07, 08]
---
# 05 — `deck-build.ts` becomes an orchestrator; CLI + tool wired

> Spec §4.8, decision D3. **The compatibility lock lives here.**

## What to build

`deck-build.ts`: resolve manifest → per slide `layoutFor(resolveLayout(slide))` →
`emit-pptx` (+ `emit-html` for composed layouts) → write → announce. `addChrome`,
`PALETTES`, `STAGE`/`CONTENT` and the inline diagram call are gone from this file.

`parseManifest` accepts the new fields and keeps requiring `title`; a slide with neither
`ir` nor a `layout` is an error naming both remedies.

`scripts/deck.ts` + `lib/export-pptx.ts`: no new required flags. Tool schema gains the new
optional slide fields via the manifest only — **do not grow the tool's own schema surface**
(schema-cost canary).

## Acceptance — the lock

- `examples/deck/deck.config.json` builds **with no edit**, producing per-slide
  shape/text counts `23/21, 43/26, 59/20, 62/49, 34/21`.
- Cross-emitter consistency: for one slide of each composed layout, the set of text strings
  in the HTML equals the set in the PPTX.
- `__tests__/deck.test.ts`, `deck-announce.test.ts`, `thumbnails.test.ts`,
  `pptx-shapes.test.ts`, `export-pptx.test.ts` all still pass unmodified where they assert
  behaviour rather than internals.

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`

## Result

**closed 2026-08-21** — `deck-build.ts` is now an orchestrator; `addChrome`, `PALETTES`,
`STAGE`/`CONTENT` and the inline diagram call are gone from it.
`__tests__/deck-composition.test.ts`, 20 tests.

**The lock holds at the byte level, not merely at counts.** The legacy deck's five slide XML
parts were captured before the refactor and compared after: all five **byte-identical**. The
first comparison was not — see ticket 03's `algn="l"` fix, which counts alone would have
missed.

Shape/text counts moved `23/21…` → `25/25…` (+2 shapes, +4 texts per slide). Not a geometry
change: the old counter returned only what `addShapeIrToSlide` placed and never counted the
chrome. Same slide, honest total; the README's `358` is now `388`.

`archify_export_pptx` gained no new required parameter — the layouts reach it through the
manifest, so the schema-cost surface is unchanged. Its `details` now carry `layout` per slide,
the title `storyline`, and any advisory `lint` notes.
