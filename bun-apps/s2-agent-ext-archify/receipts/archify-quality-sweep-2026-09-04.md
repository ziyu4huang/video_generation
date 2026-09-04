# archify quality sweep — 2026-09-04 (t40)

Sweep of the phase-1–3 surfaces (library deck, ir-slot templates, converted IRs) plus the
benchmark deck `aspice4-chip-v5` (25 slides, scratch copy — the delivered
`~/proj/output/aspice4-chip-v5.pptx` was never written).

## Medium

The quicklook PNGs were judged "not so good" (operator, 2026-09-04); the sweep switched to
the **HTML/SVG twins** captured stage-exact: each `slide-N.html` shot at its `.stage`
bounding box via Bun.WebView (Chrome backend), `overflow:hidden` injected, viewport
resized to the measured stage. First-round captures at a fixed 1280×720 produced
systematic false defects (body scrollbars on the interactive diagram-viewer pages) —
9 of 25 / 14 of 21 first-round fails were capture artifacts, reclassified after
stage-exact re-capture and direct slide inspection.

## Renderer-free gates (all green)

- Builds + deck-lint + ooxml-lint: library deck (21 slides / 1159 shapes / 868 KB),
  deck-general (15 / 544), benchmark (25 / 968 / 815 KB).
- roundRect adjustment audit: 741 adj values across 61 slides, **0 over the 50000 cap**;
  **0 `<a:blip>`** (pure vector decks).
- Full suite after fixes: 725 tests / 0 fail; `tsc --noEmit` clean.

## Defects found → fixed (cross-emitter, template layer)

1. **timeline** — the rule root and the milestones grid each took the full content
   region, so note bands landed ON the rule (library slide 10: "RFQ answered" /
   "PPAP sample" overstruck). Fixed: one root vertical stack now divides the well into
   date-band / rule / label+note bands (dates above the rule, labels + notes below —
   the documented design).
2. **compare** — `repeat flow:"col"` stacks vertically; the contract says side-by-side
   50/50 (library slide 7: both groups in the left 35 %). Fixed: `flow:"row"`.
3. **agenda** — inner stack `dir:"row"` stacked the note UNDER the title; the contract
   puts it to the right (library slide 19). Fixed: `dir:"col"`. Payload: agenda item 4
   was silently missing its time box — added "5 min".
4. **statement overflow (folded back as a gate)** — aspice4 slide 13's 223-char
   statement (Latin + PingFang TC, 34 pt) set ~7 lines in a 4-line slot: top clipped,
   accent rule through the last line. New `statement-overflows` lint rule (error
   severity, same exemption reasoning as t02's `title-overflows`) covering both the
   `statement` code layout and the `quote` template; capacity uses the title-calibrated
   extent model × a measured 0.72 (rendered ~16 em/line vs 22 predicted at 34 pt).
   Proof: `bun run deck` on the benchmark deck now **refuses** with
   `slide 25: statement sets about 7 lines against a 4-line slot` — content fix belongs
   to the deck's author (shorten the statement).

Geometry pins for all of the above live in `tests/quality-sweep.test.ts`
(PlacedBlock-level, renderer-free); template goldens regenerated
(`UPDATE_TEMPLATE_GOLDENS=1`).

## Recorded, not fixed

- Diagram-artifact canvas dead space on full-width `diagram` slides (aspice4 slide 21:
  a 5-node row over ~70 % empty canvas) — the P4 class on the D3-locked path; fixing
  means renegotiating the frozen diagram-layout coordinates (user decision).

## Verdict

The four renderer-free fidelity gates held on every new phase-1–3 surface; the defects
that remained were template-geometry contracts the gates could not see (rule/stack
overlap, repeat direction, silent optional-field drops, statement budget). All four are
now either fixed in the templates or enforced as an error-severity lint rule.
