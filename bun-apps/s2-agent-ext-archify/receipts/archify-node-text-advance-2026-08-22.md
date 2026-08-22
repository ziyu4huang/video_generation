# Receipt — P3: a Latin advance cannot measure an ideograph; diagram labels now reserve by script

- **Date:** 2026-08-22 (commit `9156af09f`; ambiguous-glyph calibration follow-up `4ba8e093d`
  same day)
- **Machine:** darwin arm64 (Darwin 25.5.0), bun 1.4.0, pptxgenjs 4.0.1, macOS Quick Look
  (`qlmanage`) for the by-eye verification renders
- **Effort:** `.planning/2026-08-21-archify-deck-visual-fidelity/` ticket 03 (P3)
- **Scope:** the label measurements below were taken on this machine, from the emitted box
  widths of the real example deck, compared against `textEms()` model estimates. Nothing is
  quoted from documentation.

## The defect, quantified before touching anything

`lib/pptx-shapes.ts` placed SVG text with `wrap: false` and reserved
`fontSize * 0.62 * text.length * 1.35` ≈ **0.837 em per character** — one Latin advance
applied to every script. All **137 labels across the five slides of `examples/deck/`** were
measured old-estimate vs `textEms()`:

| class | old ÷ model | verdict |
|---|---|---|
| Latin / mixed | 1.07–1.68× | over-reserved (harmless, but wide boxes) |
| pure CJK (40 labels) | 0.837× | **every single one short** |

`系統需求` was given 3.35 em for a 4.00 em string — 3.35 characters fit, which is precisely
why it broke as `系統需 / 求`. Same cause for the MRD node's `來源` tag, and for 19 labels on
slide 4 alone.

## The fix

`labelWidthEms(text) = max(1, textEms(text)) * 1.15`, wired into the text placement. Two
parts, each with a number:

- **`textEms()`** — the script-aware model ticket 02 built for the title band, already
  calibrated against rendered ink (±1.7 % on prose).
- **The 1.15 headroom is not an insurance premium.** The model's worst measured bucket miss
  is `M`: 0.90 em real against 0.78 modelled (−13 %). And `wrap: false` needs an **upper
  bound**, not a best guess, because not every OOXML renderer honours `wrap="none"` — Quick
  Look does not, which is exactly why it broke the lines that PowerPoint left whole.

`wrap: false` is kept, unchanged: this path replays a diagram whose SVG already decided
where the lines break; turning on wrapping would reflow text the diagram positioned
deliberately.

## Acceptance — what was met, and one substitution

- **Width contract, renderer-free:** `__tests__/pptx-mapper.test.ts` asserts, over fixtures
  spanning pure-Latin (`Message bus`, `AUDIO APU`, `MMMM`), pure-CJK (`系統需求`, `來源`),
  and mixed (`SYS.1/2 需求`, `≥ 2 GB/s 配額`, `PG_AUDIO · PG_CAM`), that the reserved width
  ≥ the script-aware estimate, that ideographs get a full em (the exact 3.35-vs-4.00
  regression), and that headroom exists over the model rather than parity.
- **By-eye check — SUBSTITUTED.** The ticket asked for it "once by eye via ticket 05"
  (the portable render seam). Ticket 05 is not built. It was done instead with the ticket-02
  scratch Quick Look pipeline (`qlmanage`, all five slides rendered before and after): every
  previously-broken label — `系統需求`, `體檢` (was `體/檢`), `壞散文` (was `壞散/文`),
  `寫得對不對` (was `寫得有不/對`) — is now one line. Latin labels' boxes got visibly
  narrower (`IF·ALLOC·BUDGET·FSM`, `AXI4 64-bit`) and **none of them wrapped**. Same
  renderer, same machine, same by-eye standard; only the reusable seam is missing.
- **No renderer in the assertion:** met — the contract tests never render.
- **Width bytes moved and were accounted for:** the legacy deck's diagram slides rebuilt
  with new reserved widths; the D3 byte-identity lock (which pins the `diagram` slide XML
  against the pre-composition builder) still passes, as the lock covers geometry invariants
  and the reserved-width change is deliberately part of the label contract.

## Gates

```
bun run typecheck   clean
bun test            445 pass / 21 skip / 0 fail   (433 / 21 / 0 before)
```

Both example decks build; content lint + ooxml lint clean on both.

## Follow-up found while closing this ticket

Eyeballing the after-render flagged the East Asian Ambiguous glyphs (`≥ · ≈ ▶ ↔ ≠ ×`) — the
model gave them 0.6 em with no measurement behind it. They have since been measured with a
clean ink window and the model corrected: `≥ ≤ ≈ ≠ ▶` → wide (0.78), `↔ ℃` → full width;
`× ÷ ±` were already right, `· °` over-reserve safely. Receipt:
`archify-ambiguous-advance-2026-08-22.md`. Diagram labels inherit that correction through
`textEms()` at no further cost.

## One defect seen and deliberately not touched here

Slide 3's `DETAIL · ~64 個` renders overlapping `HWE.2` vertically — in the before AND after
renders, so pre-existing and not a P3 regression. Recorded on ticket 04's attribution step
in the effort map.
