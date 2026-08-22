# Receipt — East Asian Ambiguous glyph advances: the model's blind spot, re-measured

- **Date:** 2026-08-22
- **Machine:** darwin arm64 (Darwin 25.5.0), bun 1.4.0, pptxgenjs 4.0.1, macOS Quick Look
  (`qlmanage`) as the OOXML renderer
- **Effort:** `.planning/2026-08-21-archify-deck-visual-fidelity/` — correctness follow-up on
  ticket 02's calibration (`archify-title-wrap-calibration-2026-08-22.md`), surfaced while
  closing ticket 03
- **Scope:** everything below was measured on this machine. Nothing is quoted from
  documentation, and no font file was parsed.

## Why a second measurement was needed

Ticket 02's buckets were calibrated on ideographs, em-dash-class punctuation, and Latin
prose. The East Asian **Ambiguous** math glyphs — `≥ · ≈ ▶ ↔ ≠ ×` and kin — were never
measured; they fell into `other` (0.6 em) by default. PNG eyeballing suggested `≥` was
0.78–0.83 em, i.e. the model under-reserves, and an under-reserving model is the exact
defect class ticket 02 exists to prevent: **a lint that passes a title which actually
wraps.**

A first probe attempt produced 9.192 in for all nine glyphs — a constant. A constant
span across different glyphs is the **window, not the ink**: the ink bounding box had
swallowed the tag chip band and the accent rule. Those numbers were discarded unquoted.

## Method — same as ticket 02, plus a clean-window protocol

One-slide `bullets` deck per glyph (title = glyph × 16, `defaults.font: "PingFang TC"`,
`title` role 26 pt bold) → `qlmanage -t -s 1600` (120 px/in) → `sips` BMP → ink bounding
box, advance ∈ [span/16, span/15] em.

The window this time, derived from the geometry in `layouts.ts` / `deck-theme.ts`:

- **x ∈ [0.40, 9.50] in** — upper bound is the title band's own right edge
  (`TITLE_BAND.alone` = x 0.5, w 9.0), strictly left of the tag chip (x ≥ 9.7).
- **y ∈ [0.12, 1.00] in** — inside the band (y 0.22…0.97), strictly above the accent rule
  (y 1.02).

**The protocol that makes it trustworthy: sanity glyphs first.** `一 → M 0 i` were run
through the identical pipeline before any new number was accepted; they reproduced the
ticket-02 receipt (1.001, 1.004, 0.900, 0.600, 0.270 — expected 1.00, 1.00, 0.90, 0.60,
0.27). Only then were the ambiguous glyphs measured. All results below are single-band
(no wrap), confirming the window caught only the title line.

## Measured

| glyph | span (in) | advance (em) | was | now |
|---|---|---|---|---|
| `≥` `≤` `≈` `≠` | 4.500 | **0.779–0.831** | other 0.6 | wide 0.78 |
| `×` `÷` `±` | 3.492 | 0.604–0.645 | other 0.6 | other (unchanged) |
| `·` | 2.783 | 0.482–0.514 | other 0.6 | other (unchanged) |
| `▶` | 5.058 | **0.875–0.934** | other 0.6 | wide 0.78 |
| `↔` | 5.492 | **0.950–1.014** | other 0.6 | full width 1.0 |
| `°` | 1.933 | 0.335–0.357 | other 0.6 | other (unchanged) |
| `℃` | 5.367 | **0.929–0.991** | other 0.6 | full width 1.0 |

`↕ ▲ ◀` were attempted for family completeness and **rendered blank** — no ink anywhere
in the band, so no width can be read. They stay in `other` as a recorded unknown rather
than a guess either way.

## Why nearest-bucket placement is enough

The worst residual after placement is `▶`: 0.78 reserved against a 0.875–0.934 reality,
≤ 0.154 em short per character. `deck-lint` warns inside a 5 % margin of the 24.37 em
budget — ≈ 1.2 em — and errors only past the budget itself. Flipping any verdict needs
the accumulated per-character residuals to exceed that margin: **eight `▶` in one
title**, or two dozen `≥`. The residual is noise at title scale, which is why no fifth
bucket was added for a 0.9-em class of rare glyphs. (Ticket 02 already ships a worse
tolerated miss: `M` at −13 %.)

## What changed

- `lib/text-extent.ts` — `WIDE` gains `≥ ≤ ≈ ≠ ▶`; `FULL_WIDTH_RANGES` gains `℃`
  (0x2103) and `↔` (0x2194, extending the arrow range; `↕` 0x2195 deliberately NOT
  included — unmeasurable). `·` `°` `× ÷ ±` measured and left as they were.
- `__tests__/text-extent.test.ts` — the twelve measured intervals are frozen as data
  (`calibration — East Asian Ambiguous math glyphs`), with the ±20 %-of-midpoint
  assertion, the ↔/℃-vs-≥-family split, and the `↕ ▲ ◀` blank-render record.

## Verified

- `bun run typecheck` clean; `bun test` **479 pass / 21 skip / 0 fail** (445 before).
- Both example decks build; content + ooxml lint unchanged — `examples/deck` slide 2's
  `title-overflows` warn reads identically before and after, i.e. no verdict flipped,
  as the noise analysis predicts.
- D3 byte-identity lock on `examples/deck` holds (part of the suite).

## Reproducing

Same scratch harness as the ticket-02 receipt, with the window above. The one rule worth
keeping for whoever does this next: **run the sanity glyphs through the pipeline before
believing any new number, and treat a constant span across different glyphs as a dirty
window, not as data.**
