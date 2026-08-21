---
ticket: 02-layouts
effort: archify-slide-composition
type: task
status: closed
created: 2026-08-21
last: 2026-08-21
blocks-on: [01]
blocking: [03, 04, 05]
---
# 02 — `lib/layouts/` — six pure functions

> Spec §4.2. Format-neutral: nothing here imports pptxgenjs, HTML, or a colour value.

## What to build

`chrome(slide, ctx) => PlacedBlock[]` — tag panel, tag text, title, takeaway (when present),
accent rule, source/subtitle footer, page number. **Coordinates must be today's
`addChrome()` values expressed as fractions of 13.333 × 7.5** — that is what makes D3 hold.

Six layouts: `title`, `section`, `bullets`, `split` (default `ratio` **0.6**), `diagram`,
`statement`. `layoutFor(name)` dispatches.

`diagram` = `chrome` + one diagram block at today's
`CONTENT {x:0.5, y:1.18, w:12.333, h:5.7}` in fractions.

## Acceptance

- Golden `PlacedBlock[]` fixture per layout under `__tests__/fixtures/layouts/*.txt`,
  regenerated with `UPDATE_LAYOUT_GOLDENS=1 bun test`.
- Every block's box lies within `[0,0,1,1]` (a fractions-vs-inches mix-up is loud).
- `diagram`'s blocks convert back to today's inch coordinates exactly (unit test with the
  literal numbers, not a re-derivation).

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`

## Result

**closed 2026-08-21** — `lib/layouts.ts` (ONE module, not the `lib/layouts/` directory the
spec first named: six ~20-line functions plus a shared `chrome()` read better together, and
the helper gets an obvious home). `__tests__/layouts.test.ts`, 27 tests.

- Goldens for all six under `__tests__/fixtures/layouts/*.txt`, one line per block;
  regenerate with `UPDATE_LAYOUT_GOLDENS=1 bun test`.
- The `diagram` layout's seven blocks are asserted against the OLD builder's literal inch
  coordinates, not a re-derivation — including the detail that the footer text run is emitted
  even when there is no subtitle, because the old code wrote `opts.subtitle ?? ""`
  unconditionally and the run count is part of the compatibility surface.
- `chrome()` moves the title band only when a `takeaway` is present; with none, the output is
  coordinate-for-coordinate what it was.
