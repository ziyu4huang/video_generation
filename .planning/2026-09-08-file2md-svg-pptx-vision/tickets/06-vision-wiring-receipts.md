# Ticket 06 — vision wiring + live receipts

## Goal

Mermaid hint in the diagram/figure prompts with a light fence/keyword
validator (D15); this machine's model-tiers `capabilities.vision` pointed at
`zai/glm-5.3-flash`; three live receipts recording provider/modelId,
renderer id, and every degrade notice (D16).

## Files

- `src/vlm/agents.ts` (mermaid hint in figure/diagram prompt variants)
- `src/vlm/mermaid.ts` (light validator + fence stripper) + tests
- `~/.pi/workflows/model-tiers.json` (machine config, not committed)
- `.planning/2026-09-08-file2md-svg-pptx-vision/receipts/` (committed)

## Done when

- [x] validator unit tests: accept mermaid block / strip bad fence / keep prose
- [x] mocked E2E proves a mermaid block survives into `## Figure (vision)`
- [x] model-tiers vision capability = zai/glm-5.3-flash, verified by a run's
      stderr `model: zai/glm-5.3-flash` line (vlm mode)
- [x] receipt A: svg fixture, smart mode
- [x] receipt B: html-with-inline-svg fixture, smart mode
- [x] receipt C: INCOSE deck, smart mode (all 5 slides, no rate-limit subsetting needed)
- [x] every receipt records provider/modelId + renderer id + degrade notices;
      failing receipts are filed as evidence, never deleted

## Resolution

closed: 2026-09-08 — `src/vlm/mermaid.ts` (8 tests incl. explainPage E2E) +
`MERMAID_HINT` in figure/diagram prompts; `~/.pi/workflows/model-tiers.json`
capabilities.vision = zai/glm-5.3-flash; receipts in
`receipts/live-vision-2026-09-08.md` (renderer quicklook, zero degrades).

