---
ticket: 03-shape-ir
effort: archify-view-pptx-bun
type: task
status: open
created: 2026-08-21
blocks-on: [01, 02]
blocking: [04]
---
# 03 — archify: `lib/shape-ir.ts` (normalized, paint-ordered shape IR)

> Spec §4.1. The seam every exporter consumes.

## Goal

`SvgDoc` → one flat, paint-ordered `ShapeIR` in SVG user units, format-neutral.

## What to build

`toShapeIR(doc: SvgDoc, theme): ShapeIR` per the spec §4.1 type. Responsibilities:

1. **Path parsing** — absolutize the measured command set: `M L Q Z V H` and relative
   `m l c s v h`; also handle `C`/`A` defensively. `s` (smooth cubic) needs the reflected
   previous control point. An **unknown command must throw**, naming the command and the
   `d` string — silently dropping geometry is the failure mode this ticket exists to prevent.
2. **Transform application** — apply each node's `ctm` (from ticket 01) to its geometry so
   downstream consumers never see transforms.
3. **Pruning** — drop `title` / `desc`, the `<defs>` subtree (`defOnly`), and the
   `fill="url(#grid)"` background plate. Keep marker polygons addressable by id for ticket 04.
4. **Order** — the output array order IS paint order. Preserve it.

## Acceptance

- Golden ShapeIR fixtures committed for **all five** diagram types, generated from the
  vendored examples (`vendored/examples/*.json`).
- Round-trip sanity: every ShapeIR node's bounding box lies within `[0,0,width,height]`
  (catches a transform composed in the wrong order).
- A fixture containing an unsupported path command fails with a named error.

## Gate

`( cd bun-apps/pi-agent-ext-archify && bun run typecheck && bun run test )`
