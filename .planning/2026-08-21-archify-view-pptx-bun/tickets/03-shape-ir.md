---
ticket: 03-shape-ir
effort: archify-view-pptx-bun
type: task
status: closed
created: 2026-08-21
last: 2026-08-21
blocks-on: [01, 02]
blocking: [04]
---
# 03 — archify: `lib/shape-ir.ts` (normalized, paint-ordered shape IR)

> Spec §4.1. The seam every exporter consumes.

## Goal

`SvgDoc` → one flat, paint-ordered `ShapeIR` in SVG user units, format-neutral.

## What to build

`toShapeIR(doc: SvgDoc, theme): ShapeIR` per the spec §4.1 type. Responsibilities:

1. **Path parsing** — absolutize the command set measured across ALL FIVE diagram types
   (13 vendored examples rendered 2026-08-21): `M L Q Z V H A` and relative
   `m l c s v h a`. `s` (smooth cubic) needs the reflected previous control point; `A`/`a`
   are real (12 occurrences each — arcs appear outside architecture diagrams). An
   **unknown command must throw**, naming the command and the `d` string — silently
   dropping geometry is the failure mode this ticket exists to prevent.
2. **Transform application** — apply each node's `ctm` (from ticket 01) to its geometry so
   downstream consumers never see transforms.
3. **Element coverage** — measured across all five types: `rect`, `text`, `path`, `circle`,
   `ellipse`, `polygon`, **`line`** (9 occurrences; absent from architecture diagrams, so it
   is easy to miss), plus structural `g` / `defs` / `marker` / `pattern` / `title` / `desc`.
4. **Pruning** — drop `title` / `desc`, the `<defs>` subtree (`defOnly`), and the
   `fill="url(#grid)"` background plate (the ONLY `fill` attribute in the whole corpus).
   Keep marker polygons addressable by id for ticket 04.
5. **`style` carries no paint** — measured: every `style` attribute in the corpus is
   `--step:N` (an animation-ordering custom property). Ignore it, and say so in a comment so
   nobody adds a CSS-declaration parser for it later.
6. **Order** — the output array order IS paint order. Preserve it.

## Acceptance

- Golden ShapeIR fixtures committed for **all five** diagram types, generated from the
  vendored examples (`vendored/examples/*.json`).
- Round-trip sanity: every ShapeIR node's bounding box lies within `[0,0,width,height]`
  (catches a transform composed in the wrong order).
- A fixture containing an unsupported path command fails with a named error.

## Gate

`( cd bun-apps/pi-agent-ext-archify && bun run typecheck && bun run test )`

## Result

**closed 2026-08-21** — `lib/shape-ir.ts` (+ `formatShapeIR`) with
`__tests__/shape-ir.test.ts` (40 tests) and `__tests__/arc-reference.test.ts` (1 test).

- Golden fixtures committed for all five types under `__tests__/fixtures/shape-ir/*.txt`.
  Format is one line per shape in paint order, NOT JSON — a 93-156 line golden whose diff
  reads as "this box moved" instead of hundreds of lines of re-indented punctuation.
  Regenerate with `UPDATE_SHAPE_IR_GOLDENS=1 bun test`.
- All 13 vendored examples convert with zero out-of-bounds nodes (transform composition
  verified) and zero throws.
- **Two real bugs caught by these tests**, both of the silent-wrongness kind this ticket
  targeted: (1) the path tokenizer's regex matched only VALID command letters, so an unknown
  command such as `X` was silently dropped instead of rejected — now any `[A-Za-z]` is
  tokenized and unknown ones throw; (2) see ticket 02's sigil inheritance correction.
- **Arc conversion verified against ground truth**: `arc-reference.test.ts` compares our
  arc→cubic output with WebKit's own `getBBox` over 7 arc forms via `Bun.WebView` (194 ms,
  nothing to install). Max deviation 0.12 user units on shapes 12-20 units across, and that
  residual is the harness's Bezier sampling, not the conversion. This settled a sweep-direction
  question that intuition had gotten backwards.
