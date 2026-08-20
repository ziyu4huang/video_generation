---
ticket: 05-deck-rewrite-and-tool
effort: archify-view-pptx-bun
type: task
status: open
created: 2026-08-21
blocks-on: [04]
blocking: [06, 09]
---
# 05 — archify: deck without Playwright + `archify_export_pptx`

> Spec §4.3. This is the ticket that actually deletes the browser from the PPTX path.

## What to build

1. **`lib/deck-build.ts`** — the shared core: manifest → for each slide `deliver` (unchanged,
   still validated) → read HTML with `Bun.file` → `parseSvg` → `toShapeIR` →
   `addShapeIrToSlide` → slide chrome (title / accent rule / tag / subtitle / page number,
   the existing `PALETTES` light+dark) → write `.pptx`.
2. **`scripts/deck.ts`** — becomes a thin CLI over `deck-build.ts`. Remove the `playwright`
   import, `chromium.launch()`, the PNG temp files, and `pngDims`. CLI surface unchanged:
   `bun run deck [manifest] [--theme light|dark] [--output out.pptx]`. Add
   `--emit-shape-ir <dir>` for debugging.
3. **Manifest compatibility** — `deck.config.json` shape is unchanged. `defaults.scale` no
   longer has meaning; **accept and ignore it** (do not error on existing manifests).
4. **`archify_export_pptx` tool** — registered in `extensions/archify.ts`, params
   `{manifestPath?, irPaths?, outputPath?, theme?}`; `irPaths` builds an implicit manifest
   (one slide per IR, title from `ir.meta.title`). Promote `pptxgenjs` from
   `devDependencies` to `dependencies`.

## Acceptance

- `bun run deck examples/deck/deck.config.json` produces a 5-slide `.pptx` **with no browser
  installed and no chromium process spawned**.
- The existing `__tests__/deck.test.ts` passes without its `ARCHIFY_DECK_TEST_BROWSER` gate —
  delete the gate, the browser precondition is gone.
- `archify_export_pptx` returns the absolute output path and reports slide count.

## Gate

`( cd bun-apps/pi-agent-ext-archify && bun run typecheck && bun run test )`
