# Ticket 02 — SVG lane

## Goal

Standalone `.svg` becomes a first-class single-page document: structural
extraction as the always-present ground-truth body, WebView raster + embed in
render-capable modes, vision in smart/vlm.

## Files

- `src/core/types.ts` (FileKind + "svg")
- `src/core/sniff.ts` (svg detection; D13: html markers win precedence)
- `src/core/svg-text.ts` (`parseSvgStructure`, `svgToMarkdown`; SVG_LABEL_MAX)
- `src/raster/svg.ts` (`renderSvgFileToPng`, `renderSvgTextToPng`; two-pass
  WebView per D21 — probe-measure via element rect, capture at measured size)
- `src/pipeline.ts` (`runSvg`, dispatched after image)

## Mode matrix (as shipped — D19/D20)

- text → structural only, no raster
- auto/ocr → structural + embed (NO OCR call — XML labels are ground truth)
- vlm → full vision page note (diagram profile), structural degrade
- smart → structural + `## Figure (vision)` append; degrade = skip notice +
  `figure:{detected:true,enhanced:false}`; raster unavailable → notice, never
  a failure

## Done when

- [x] sniff: `.svg` ext + `<svg[\s>]` content claimed as svg; html-markered
      content NOT claimed (D13)
- [x] svgToMarkdown: title/desc/viewBox + labels + shape census + loss notice
- [x] live raster smoke: 640×480 fixture → 640×480 png (37 KB) and 320×240 at
      maxEdge 320 (element-rect measurement verified)
- [x] E2E (mocked vision, mocked raster for degrade): text never throws;
      auto stores png + embed; smart+server appends `## Figure (vision)` +
      `enhanced: vision` + manifest figure record; smart no-server → skip
      notice + `enhanced:false`, page still done
- [x] typecheck green

## Resolution

closed: 2026-09-08 — all gates green (`__tests__/svg-lane.test.ts`); live
smoke receipts in tickets/06.
