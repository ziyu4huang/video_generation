---
type: task
status: closed
---

# 40 — quality sweep: the fidelity gates meet the library deck and the benchmark

## Question

Phases 1–3 shipped new content the four `archify-deck-visual-fidelity` gates have never
seen: the flagship library deck (`examples/ir-library/decks/library.config.json`), the
mermaid-converted IRs, and the three ir-slot templates. The benchmark deck
(`~/proj/output/archify-aspice4-v5/`, 25 slides, 11 hand-authored IRs) is the harvest-tier
artifact whose visual review earlier sessions deferred. Do the measured defects
(title-band wrap, takeaway placement, node-text advance, split fit, roundRect bursts)
reappear on any of it — and if they do, do the fixes fold back as renderer-free gates?

## What to build (design-first scope)

1. **Renderer-free gate re-run** (D1: the renderer sees, it never gates):
   `bun run deck` (build + deck-lint incl. the title-wrap error gate + ooxml-lint) on
   the library deck and on a deck that exercises the three ir-slot templates with
   real IRs; `architecture:render` + validate on every IR in the library. The
   ir-library.test.ts gate already covers the flagship — the sweep checks the surfaces
   tests do NOT pin: the benchmark deck build (outside the repo — receipt evidence
   only, no gate can reference it) and the converted IRs.
2. **Visual pass via the on-demand seam** (`deck render`, quicklook backend): the
   library flagship deck and the full 25-slide benchmark deck. Review every rendered
   slide for the five measured defect classes. This closes the deferred harvest-tier
   visual review.
3. **Fold back**: any defect found gets the renderer-free fix (the fidelity effort's
   pattern: fix, re-render, refuse to accept an unchanged image); a *new* measured rule
   becomes a renderer-free gate, never a render-dependent one (D1/D3 — no golden
   pixels in git).
4. **Receipt**: `receipts/archify-quality-sweep-<date>.md` with the per-deck numbers
   (slides, shapes, blips, lint diagnostics, render timing) and the visual verdicts.

## Result (2026-09-04)

All four template-layer defects fixed (timeline rule-overlap, compare flow direction,
agenda note column + silent missing time box) and the measured statement overflow folded
back as the error-severity `statement-overflows` lint rule — it refuses the benchmark
deck until its author shortens slide 13's statement. Renderer-free pins in
`tests/quality-sweep.test.ts`; goldens regenerated; suite 725/0, tsc clean. Full method
(first-round capture artifacts vs real defects), numbers and verdicts:
`bun-apps/s2-agent-ext-archify/receipts/archify-quality-sweep-2026-09-04.md`. Canvas
dead-space on D3-locked diagram slides recorded, not fixed.

## Acceptance

- [x] Library deck + ir-slot deck + benchmark deck build lint-clean (0 diagnostics);
      every library IR validates.
- [x] Rendered images of both decks reviewed slide-by-slide; verdicts recorded in the
      receipt (defect found → fixed + gate folded back, with before/after numbers).
- [x] RoundRect adjustment audit: 0 values > 50000 in any swept deck's slide XML.
- [x] Receipt committed; `bun run typecheck && bun run test` green; no existing
      example byte-changed (D5 lock).
