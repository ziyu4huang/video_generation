# Ticket 05 — PPTX lane (rendered slide notes)

## Goal

pptx becomes a real multi-page document like the pdf lane: manifest
pageCount = slide count, per-slide `pages/page-NN.md` with the ground-truth
text-run body + `![[page-NN.png]]` embed, `--pages` filter, resumability;
vision on diagram-shaped slides in smart, all slides in vlm.

## Files

- `src/pipeline.ts` (`runPptx` before runOffice; `isDiagramSlide` +
  SLIDE_DIAGRAM_TEXT_MAX_CHARS=120; `slideBody`; renderer-null in-output
  notice branch)

## Mode matrix (as shipped)

- text → runOffice delegation (byte-identical by construction, D8)
- auto/ocr → render + embed + text-run body (no VLM)
- vlm → render + describe ALL slides (validated full note; degrade =
  text-run body)
- smart → heuristic (slide XML `<p:pic>`/`<p:graphicFrame>` OR slide text
  < 120 chars) → ONE `## Slide (vision)` append; degrade = skip notice +
  figure record; no renderer → today's text-only output + in-note notice
  (D16)

## Done when

- [x] E2E with mocked renderer + mocked vision: manifest pageCount = slides;
      per-slide md with embed + text body; smart heuristic fires on a pic
      slide and not on a prose slide; text mode = runOffice output; renderer
      null → notice + png:null; `--pages "2"` processes slide 2 only
- [x] render happens at most once per run (work-dir render, then copy)
- [x] typecheck green

## Resolution

closed: 2026-09-08 — gates green (`__tests__/pptx-lane.test.ts`); live INCOSE
receipt in tickets/06.
