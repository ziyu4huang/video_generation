---
ticket: 04-split-diagram-fit
effort: archify-deck-visual-fidelity
type: task
status: done
created: 2026-08-21
last: 2026-08-22
---
# 04 — measure the split slide's diagram placement before changing it

> Spec §2.4, §4 (P4), decision D5.

## The observation

On composed slide 3 the diagram occupies roughly the lower half of its column with a large
empty band above it. `addShapeIrToSlide` is documented to scale uniformly and centre inside
the target `Box`, so the render disagrees with the documentation.

**Widened 2026-08-22 (while closing ticket 03) — the attribution step covers three
sightings, not one:**

1. the original: a `split` slide's diagram sits small and low in its column;
2. the legacy deck's slide 3 (`examples/deck/`, full-width `diagram`, NOT `split`) also
   renders its diagram low with a large empty band above — so the cause is probably not
   `split`-specific;
3. **the legacy deck's slide 3 shows `DETAIL · ~64 個` overlapping `HWE.2` vertically** —
   present in the pre-P3 AND post-P3 renders, so pre-existing and NOT a P3 regression.
   Whether it is the same root cause (a mis-scaled or content-vs-canvas bbox pushing
   content into occupied space) is precisely what the attribution step must decide.

**Attribution is not established, and this ticket does not assume a bug.** Two candidates:

1. centring is wrong — the diagram is placed against the box's bottom-left rather than its
   centre;
2. centring is right, and the artifact's own bounding box includes the legend row plus empty
   canvas, so the *visible* content sits low inside a correctly-centred but mostly-empty
   box.

Candidate 2 is at least as likely as candidate 1 — the legend row in the round-1 render sits
well below the diagram frame.

## What to build

**First a measurement, then a change only if the measurement calls for one.**

Compare, for composed slide 3 AND for the legacy deck's slide 3 (both sightings above): the
artifact SVG's own `viewBox` / content bbox, the target `Box` handed to
`addShapeIrToSlide`, and the emitted `<a:off>` / `<a:ext>` of the resulting shapes. Record
the three side by side, per slide, in the ticket Result.

- If candidate 1: fix the centring, assert the emitted bbox is centred in its box.
- If candidate 2: the honest fix is fitting to the diagram's **content** bbox rather than its
  canvas bbox. That is a bigger change than it looks — it affects the `diagram` layout too,
  where today's geometry is locked to the coordinate by D3 of the prior effort. If so,
  **stop and re-scope** rather than quietly changing the locked path.
- If neither — placement is correct and the emptiness is in the source diagram: close the
  ticket with the measurement, change nothing.

## Acceptance

- The three-way measurement is recorded whatever the outcome.
- Any change ships with an assertion pinning the placement, computed from emitted OOXML.
- The `diagram` layout's locked geometry is either untouched or the lock is explicitly and
  separately renegotiated.

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`

## Result — 2026-08-22: candidate 2, confirmed three ways; sighting 3 is source-authored

Measured with the real pipeline (vendored `deliver` → `parseSvg` → `toShapeIR` → the real
`layoutFor` box), and cross-checked against the emitted `<a:off>` of the built `.pptx`
(diagram shapes on legacy slide 3 cluster y ∈ [3.1, 6.25] in — exactly the predicted
content band). Scratch harness, not shipped code.

### The centring is exact — candidate 1 is dead

Legacy slide 3: left/right gaps inside the box are 0.41 / 0.41 in, both sides equal.
The uniform-scale-and-centre does what it says. What it centres is the problem.

### The artifact canvases carry large dead regions — candidate 2

| sighting | canvas (SVG u) | content bbox | dead region | visible content in box |
|---|---|---|---|---|
| legacy slide 3 (`diagram`, full-width) | 1202×462 | (40,140) 1122×307 = 93 %w **66 %h** | **top 30 % empty** | 11.51×3.15 in; gaps above 1.92 / below 0.63 in |
| composed slide 3 (`split`, ratio .6) — reuses deck's `slide1.json` | 1080×420 | (16,46) 623×339 = **58 %w** 81 %h | **right 42 % empty** | 4.13×2.25 in in a 7.16×5.1 column; right gap 2.92 in |

Canvas-utilisation across ALL five legacy artifacts (content-fit vs canvas-fit, content
height on slide):

| slide | type | content % of canvas | content height: canvas-fit → content-fit |
|---|---|---|---|
| 1 | dataflow | **58 %w** 81 %h | 3.87 → **5.70 in (+48 %, fills the box)** |
| 2 | architecture | 93/90 | 5.10 → 5.70 in |
| 3 | architecture | 93/**66** | 3.15 → 3.37 in (aspect-limited; fit barely helps) |
| 4 | dataflow | 90/84 | 4.75 → 5.27 in |
| 5 | architecture | 93/73 | 3.87 → 4.15 in |

The pattern is renderer-specific: the **dataflow** renderer emits a 1080-wide canvas and
paints only ~58–90 % of it (slide 1's artifact wastes 42 % of the width — nothing in the
raw SVG sits beyond x = 646); the **architecture** renderer's slide-3 canvas has a 140-unit
empty band above the legend. Even content-fit cannot fix legacy slide 3's vertical
emptiness — its content aspect is 3.65 against a 2.16 box — but it recovers 0.76 in of top
gap there, and it is worth +48 % linear size on slide 1 and +73 % in the split column.

### Sighting 3 (DETAIL · ~64 個 over HWE.2) is authored in the source — NOT a placement defect

The artifact SVG itself carries, at the same x = 865: `<text y="361" font-size="9">DETAIL ·
~64 個</text>` and `<text y="366" font-size="7">HWE.2</text>` (`data-detail="context"` /
`"fine"` — the vendored renderer's node-sublabel stack). Five SVG units of baseline
separation for 9/7-unit type is ~55 % of the leading those sizes need; the HTML twin shows
the same collision. No CSS hides these layers. This is a vendored-renderer label-layout
defect (or an IR authoring choice), upstream of `addShapeIrToSlide`, and is routed out of
this ticket rather than "fixed" by nudging labels in the replay path — replay reflows
nothing by design.

### Per the ticket's own instruction: stopped and re-scoped

The honest fix (fit to content bbox) changes emitted bytes on EVERY diagram slide if
applied in `addShapeIrToSlide`, i.e. it touches the D3-locked path. The live lock's
assertions (chrome EMUs, shape/text counts) would survive a placement change, but the
decision "a pre-composition manifest builds to the same geometry" would not. Options
recorded for the user: (a) content-fit everywhere, renegotiating D3 explicitly;
(b) content-fit only where D3 does not reach — the composed/`split` (and future template)
path — which captures the +73 % split-column win with zero lock impact; (c) change
nothing, close with this measurement. Sighting 3 is upstream either way.

## Resolution — 2026-08-22: content fit on the composed path only; D3 untouched

**Scope chosen by the user 2026-08-22** (option b of the three recorded above): fit to
content where D3 does not reach; the `diagram` layout keeps canvas fit.

### What was built

- `slide-model.ts` — a diagram block may declare `fit: "content"`; omitted ⇒ canvas fit.
  Declarative on the block, so it is the LAYOUT that opts in, not the emitter — the same
  seam a future template will use.
- `layouts.ts` — `splitLayout` sets `fit: "content"` (with the measured reason inline);
  `diagramLayout` does not, and must not (D3).
- `pptx-shapes.ts` — `contentBoundsOf(ir)` (union of every node's `boundsOf`; a text node
  contributes its anchor point — its degenerate bbox is exactly what must participate,
  while a degenerate bbox from any other kind means "paints nothing") and a
  `fitContent` option on `addShapeIrToSlide` that rescales to those bounds and centres
  them. Canvas fit is the byte-for-byte same code path when unset: `fitW = ir.width`,
  `fitX = 0`.
- `emit-pptx.ts` — passes `fitContent` through from the block's `fit`.

### Verified

- `bun run typecheck` clean; `bun test` **486 pass / 21 skip / 0 fail** (479 before).
- **The locked path is untouched, byte for byte**: the legacy deck rebuilt before and
  after the change — all five slide XML parts identical.
- Emitted-OXML pins, one per path:
  - legacy slide 3 keeps canvas fit (first diagram ink still at 3.10 in);
  - composed slide 3's diagram now reaches the column's right edge (7.66 in; canvas fit
    reached 4.7 in) and is vertically centred in the column.
- By eye (single-slide Quick Look render): the split column is filled horizontally,
  centred vertically, no clipped or overlapping labels. Measured on the slide: content
  7.16×3.90 in where canvas fit gave 4.13×2.25 in — **+73 % linear**.
- Both example decks build; content + ooxml lint clean.

### Known asymmetry, recorded not fixed

The HTML twin still canvas-fits: the composed page embeds the artifact as an iframe sized
by the canvas aspect, and the artifact IS its own surface there. The `.pptx` is the
flattened view and now crops the dead margins; the twin keeps them. Acceptable because
the artifact remains authoritative in the browser, and an iframe cannot crop without
`object-fit` tricks on someone else's document.

### Sighting 3 — routed out, upstream

`DETAIL · ~64 個` over `HWE.2` is authored in the vendored renderer's node-sublabel stack
(baselines 5 SVG units apart for 9/7-unit type, same x, no CSS hides them, the HTML twin
shows the same collision). Fixing it means the vendored archify renderer's label layout
or the IR's own label choices — not this package's replay path, which reflows nothing by
design. Charted in the map's Fog of war for whoever next touches the vendored surface.
