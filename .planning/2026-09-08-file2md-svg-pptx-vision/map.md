---
effort: 2026-09-08-file2md-svg-pptx-vision
created: 2026-09-08
last: 2026-09-08
status: active
---

# Wayfinder map: 2026-09-08-file2md-svg-pptx-vision — SVG / HTML+SVG + PPTX diagram readability via vision

## Destination

file2md converts diagram-heavy SVG, HTML-with-inline-SVG, and PPTX inputs into
readable Obsidian markdown: rendered PNG embeds per figure/slide (WebView /
qlmanage / soffice — probed, optional, degrading) plus vision descriptions in
`smart`/`vlm` modes through the existing spawnSubagent vision seam
(zai/glm-5.3-flash on this machine). `auto` rasterizes + embeds but never
calls a VLM; `text` output stays byte-identical to today (html passthrough /
runOffice delegation). One implementation PR + live receipts on a real SVG, an
html-with-svg fixture, and the real INCOSE deck.

## Context

Planner-led arc per the self-arc-9+ discipline: `arc-plan.ts` on
`hard-problem`/zai/glm-5.3 (352 s, 6 reads, receipt
`output/arc-plan-file2md-svg-pptx-vision/plan-receipt.json`; prompt
`output/file2md-svg-pptx-vision-planner-prompt.md`). The planner confirmed the
fixed decisions and added D8–D17; its plan is preserved verbatim at
`output/arc-plan-file2md-svg-pptx-vision/plan.md`. Measured 2026-09-08 by the
main agent before dispatch:

- SVG had ZERO handling: not in `TEXT_EXT` (`src/core/sniff.ts:16-23`), no
  image magic byte → raw-XML txt passthrough; `htmlToMarkdown`
  (`src/pipeline.ts:715-742` regex chain) strips inline `<svg>` with label
  leakage; `.svg` `<img>` refs dropped.
- PPTX = text runs only: vendored reader matches `<p:sp>`/`<a:t>` (capped 20
  slides, `src/core/types.ts:53`); no `<p:pic>`/`<p:graphicFrame>`, no render,
  office lane never touches raster/OCR/vision (`runOffice`, pipeline.ts:596).
- Vision seam exists and IS a subagent: `runVisionInference` →
  `spawnSubagent(capability:"vision")`; `resolveVisionLLM` reads model-tiers
  `capabilities.vision` — glm preset → `zai/glm-5.3-flash` (vision-verified
  2026-08-28). `diagram` profile + smart figure-variant prompts exist
  (`src/vlm/agents.ts`).
- Render seams exist in archify (`src/deck-render.ts` qlmanage-promote +
  soffice routes; `src/thumbnails.ts` Bun.WebView screenshot) — entangled
  with `DeckError`/`deck-build.ts`, so vendoring slim is correct, not lazy.
- Real deck for receipts:
  `vaults_root/study-news/content/sas-mas-itemize-incose-aspice.pptx`.

## Tickets

**Phase 1 — lanes (one implementation PR)**

- [x] `tickets/01-arc-open.md` — this map + tickets; planner run + receipt
- [x] `tickets/02-svg-lane.md` — sniff kind:svg (D13 precedence: html markers
      win) + `svgToMarkdown` structural fallback + `src/raster/svg.ts`
      two-pass WebView rasterizer + `runSvg` mode matrix
- [x] `tickets/03-html-figure-lane.md` — balanced-scanner figure extraction
      (nested svg legal, script/style off-limits, local `.svg` refs only) →
      `pages/figure-NN.png` anchors + smart/vlm descriptions; no-svg html =
      byte-identical passthrough (pinned)
- [x] `tickets/04-deck-seam.md` — vendored slim `src/raster/deck.ts` (own
      PptxRenderError, pure-Bun zip, bounded limit) + pure-part tests +
      live qlmanage smoke on the real deck
- [x] `tickets/05-pptx-lane.md` — `runPptx` multi-page manifest + per-slide
      notes with embeds + smart diagram heuristic (`<p:pic>`/`<p:graphicFrame>`
      OR thin text) + vlm all-slides + text/runOffice delegation +
      renderer-null in-output notice

**Phase 2 — vision wiring + proof (same PR)**

- [ ] `tickets/06-vision-wiring-receipts.md` — mermaid hint + light validator;
      model-tiers `capabilities.vision = zai/glm-5.3-flash`; live receipts
      (SVG fixture, html fixture, INCOSE deck) recording provider/modelId +
      renderer id + degrade notices

**Phase 3 — close-out**

- [ ] `tickets/07-docs-closeout.md` — SKILL.md / docs / tool-description
      truth-sync; PR via devops chain; map close-out + Shipped-as; successor
      next-goal (hands-off gate)

## Decisions

User-fixed (2026-09-08, plan-mode approval):

- D1 vision only in smart/vlm; auto = raster+embed, no VLM; text = today's
  output. (Structurally free: `parseMode` collapses auto→ocr and only
  vlm/smart resolve a vision LLM.)
- D2 named effort (not self-arc-N; self-arc-13/14 branches already exist in
  sibling worktrees).
- D3 html scope: inline svg + local `.svg` refs only; NO full-page lane.
- D4 vision model via `resolveVisionLLM()` seam; this machine's model-tiers
  `capabilities.vision = zai/glm-5.3-flash`; receipts record provider/modelId.
- D5 vendor slim deck seam into file2md (no archify import).
- D6 ADR-0001 posture: render/vision are probed optional layers; no new deps
  (Bun.WebView is built-in).
- D7 slide cap stays 20 (reader AND renderer, one count source).

Planner-added (D8–D17): adopted — D8 pptx text mode delegates to runOffice;
D10 standalone svg = single-page figure doc; D11 rasterize once, reuse;
D13 sniff precedence html > svg; D14 balanced scanner + script/style
off-limits; D15 mermaid = prompt hint + fence/keyword validation, degrade
strips fence; D16 receipts record renderer id + degrade notices; D17
structural caption is the always-present ground-truth text.

Executor deviations from the planner text (recorded, deliberate):

- D18 (2026-09-08): slide text + count come from the VENDORED reader blob
  (`result.pptx.slides[].shapes` DOES expose per-slide runs — the planner's
  fog #3 concern didn't materialize), with deck.ts `readZipText` used only
  for the smart heuristic's raw slide-XML flags. One reader stays the truth
  source; deck.ts stays render-only.
- D19 (2026-09-08): svg auto/ocr = structural + embed, NO OCR-on-render call
  (XML labels are ground truth; tesseract-on-diagram is noise + cost). The
  planner's D17 fallback became the default; re-enable is a one-line toggle.
- D20 (2026-09-08): svg `vlm` = full vision note (body replaced, pdf-vlm
  semantics), `smart` = structural + `## Figure (vision)` append. The
  structural body is not duplicated into vlm notes.
- D21 (2026-09-08): raster sizing = element bounding rect (scrollWidth floors
  at the viewport — measured 1024×768 on a 640×480 svg), two-pass WebView
  (probe-measure → capture at measured size) because live resize is not in
  Bun.WebView's type surface.

## Frontier

t07: PR + close-out (reviewer gate PASSED — independent read-only reviewer,
APPROVE with 12 nits 2026-09-08; six fixed in-branch: comment spans
off-limits, dangling anchors on raster failure → inline notice, mermaid
sanitize extended to diagram-profile page notes, &amp; double-decode, strict
` src=`/` alt=` attribute matching, iterative scanner (stack-overflow risk),
`<script>` stripped from inline svg fragments before the WebView. Accepted
follow-ups: waitReady liveness bound (nit 7), mid-run renderer-failure
in-note trace + needRender re-attempt (nit 8), non-contiguous slide-part
degrade (nit 9), manifest reuse keyed on input identity (nit 12 — pre-existing
runPdf parity), and the disclosed htmlToMarkdown text-mode byte change (nit 1
— intentional readability fix; lane-equivalence pinned, pre-commit bytes not).

## Fog of war

- glm-5.3-flash pacing across ≤20 slide calls (PI_VLM_CONCURRENCY default 1;
  `--pages` subsetting is the pressure valve).
- `~/.pi/workflows/model-tiers.json` key spelling for `capabilities.vision`
  (verify before editing — sessions.ts:76 reads it).
- INCOSE deck slide count vs the 20 cap (decides live truncation-notice
  coverage in receipts).
- qlmanage fidelity for SmartArt/chart-heavy slides (receipt will show).

## Cross-effort links

Builds-on: `2026-08-23-file2md-bun-only-redesign` (the v2 pipeline these lanes
slot into), `2026-08-23-file2md-smart-enhance` (the `## Figure (vision)`
append + D4 degrade semantics reused verbatim),
`2026-08-23-file2md-vision-extraction` (the runVisionInference seam),
archify `deck-render`/thumbnails efforts (the render seams vendored/adapted).
Shares-decision-with: archify deck-render D1–D3 (renderer sees, never gates).

## Shipped-as

(landing — filled at close-out)
