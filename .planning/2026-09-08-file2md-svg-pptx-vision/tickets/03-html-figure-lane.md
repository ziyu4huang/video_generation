# Ticket 03 — HTML figure lane

## Goal

Inline `<svg>` blocks and local `.svg` img refs in html become
`pages/figure-NN.png` embeds with in-place anchors; smart/vlm append per-
figure vision descriptions; html without convertible figures stays
byte-identical to the pre-lane passthrough.

## Files

- `src/pipeline.ts` (`runHtml` + `extractSvgFigures` + SVG_FIGURE_MAX=8;
  html dispatch before `runTextPassthrough`)
- `src/vlm/manifest.ts` (`figureAbs`/`figureRel` layout helpers)
- reuses `src/raster/svg.ts` (renderSvgTextToPng / renderSvgFileToPng)

## Shapes

- Balanced scanner (D14): nested svg-in-svg walks depth; matches inside
  script/style spans skipped; `<img src>` converts only for relative local
  paths resolving under the input dir (no schemes, no network, truth rules).
- text mode skips the pre-pass entirely → runTextPassthrough byte-identical.
- Figure raster failure → anchor stays, degrade notice appended, doc done.
- smart/vlm per-figure `explainPage(figure:true)` appended under
  `## Figure (vision) — NN`; no server → FIGURE_SKIP_NOTICE.

## Done when

- [x] byte-identity pin: no-svg html → output identical to `htmlToMarkdown`
      golden (test compares against the un-lane pipeline output)
- [x] N inline + M img figures → N+M pngs + anchors; no `<text>` label
      leakage; nested-svg block consumed whole; svg inside `<script>` left
      alone; http(s)/data:/missing refs left as plain tags
- [x] E2E mocked-raster + mocked-vision: smart+server → exactly N+M vision
      calls with descriptions appended; one raster failure degrades that
      figure only
- [x] typecheck green

## Resolution

closed: 2026-09-08 — gates green (`__tests__/html-figures.test.ts`).
