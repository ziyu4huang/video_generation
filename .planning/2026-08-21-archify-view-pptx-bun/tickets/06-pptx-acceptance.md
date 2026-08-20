---
ticket: 06-pptx-acceptance
effort: archify-view-pptx-bun
type: task
status: closed
created: 2026-08-21
blocks-on: [05]
---
# 06 — archify: the acceptance test that defines "shape design"

> Spec §5.1. Without this ticket, nothing structurally prevents a regression to images.

## What to build

`__tests__/pptx-shapes.test.ts`:

1. **Pure-Bun zip reader** (test helper, ~25 lines): walk ZIP local file headers
   (`0x04034b50`), read `method` / `compSize` / `nameLen` / `extraLen`, inflate method-8
   entries through `DecompressionStream("deflate-raw")`, pass method-0 through.
   `Bun.Archive` does NOT work here — probed with bytes / `Bun.file` / path, all
   `Unrecognized archive format` (it accepts tar/tgz only). Do not retry it.
2. Build a deck covering **all five** diagram types from `vendored/examples/`.
3. Per `ppt/slides/slideN.xml` assert:
   - `<a:blip>` count **=== 0** — the load-bearing assertion,
   - `<a:sp>` count **>= that slide's ShapeIR node count**,
   - every ShapeIR `text` string appears in the XML.

## Acceptance

- All five types pass.
- Deliberately swapping one shape back to `addImage` in a scratch copy makes the blip
  assertion fail (verify the test can actually fail before calling it done).

## Gate

`( cd bun-apps/pi-agent-ext-archify && bun run typecheck && bun run test )`

## Result

**closed 2026-08-21** — `__tests__/pptx-shapes.test.ts` (27 tests) +
`__tests__/helpers/read-zip.ts`.

- Pure-Bun ZIP reader (local-header walk + `DecompressionStream("deflate-raw")`), because
  `Bun.Archive` was probed and cannot read zip at all — bytes, `Bun.file`, and path all
  answer `Unrecognized archive format`, while `.tgz` is accepted. No `unzip` subprocess.
- Per slide, for all five diagram types: `<a:blip>` count **=== 0**, `<p:sp>` count >= that
  slide's independently recomputed ShapeIR node count, and every ShapeIR text string present
  as a run. Slide rels are also checked for image references.
- The matcher is proved to be able to fail (a synthetic `<a:blip>` is detected), so the
  zero-count assertion is not vacuous.
- Measured on the real deck: blip=0 on every slide, with custGeom / quadBezTo / cubicBezTo /
  tailEnd all present — freeform curves and native arrowheads, not pictures.

**Visual confirmation** (one-off, not a permanent test): the ShapeIR was re-rendered back to
SVG and screenshotted beside the original artifact through `Bun.WebView`. Geometry, fills,
strokes, dash patterns, routed connectors, edge labels, sublabels and sigil glyphs all match.
No local PowerPoint renderer exists on this machine, so opening the deck in PowerPoint or
Keynote remains a manual confirmation step for a human.
