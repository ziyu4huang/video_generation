---
effort: archify-slide-composition
created: 2026-08-21
last: 2026-08-21
status: in-progress
---
# archify-slide-composition — diagram tool → presentation generator

## Destination

`bun-apps/s2-agent-ext-archify` composes real meeting decks: six slide layouts, real
wrapping PowerPoint text, one authored model emitting both `.pptx` and `.html`, and a
permanent OOXML structural validity gate — with today's diagram behaviour preserved
bit-for-bit.

## Context (measured 2026-08-21 on this machine, bun 1.4.0 / pptxgenjs 4.0.1)

- **Baseline is green and fast.** `bun test` → 268 pass / 21 skip / 0 fail (10.25 s).
  `bun run deck examples/deck/deck.config.json` → 5 slides, 302 KB, **358 native shapes,
  0.29 s**, zero images. Per slide: 23/21, 43/26, 59/20, 62/49, 34/21 (shapes/texts).
- **PPTX output is already well-formed XML.** Unzipped `probe.pptx` → 36 parts;
  `xmllint --noout` over every one: 0 errors. `<a:custGeom>` children are in the correct
  CT_CustomGeometry2D order. **Nothing in the suite asserts either fact** — the only
  structural assertion today is `<a:blip>` count 0.
- **`addShapeIrToSlide` already takes a target `Box`** (`lib/pptx-shapes.ts:135`) and scales
  uniformly with centering. Putting a diagram in a 60 % column is a different argument, not
  new code.
- **The text problem is real and located.** `lib/pptx-shapes.ts` places SVG text with
  `wrap: false` and an estimated width `fontSize * 0.62 * length * 1.35` — a Latin advance
  guess. For a CJK deck this is wrong in both directions and cannot reflow by design.
- **`pptxgenjs@4.0.1` has what the design needs**, verified in its bundled
  `types/index.d.ts`: `fit: 'none'|'shrink'|'resize'` (:1816), `bullet` (:1101),
  `indentLevel` (:1836), `breakLine` (:1094), `TextProps[]` (:1936).
- **`Bun.XML` A/B, re-run — the existing note in `lib/svg-model.ts` is too coarse.**
  On `ppt/slides/slide2.xml` (49 389 B), 50 runs: `Bun.XML.parse` **0.229 ms** vs
  `HTMLRewriter` **0.335 ms** — `Bun.XML` is 1.46× faster. Order across *distinct* sibling
  tags is **preserved** (object key insertion order): `p:spPr` reads back as
  `["a:xfrm","a:custGeom","a:ln"]`, which is document order. Order across *repeated*
  sibling tags is **lost**: a real path `moveTo, lnTo, quadBezTo, lnTo` reads back as
  `{a:moveTo, a:lnTo:[…,…], a:quadBezTo}` — segment 4 merged into segment 2's array and
  `quadBezTo` moved behind both. Four `preserveOrder`-style spellings were probed:
  **silently accepted, no effect.** OOXML has no boolean-attribute problem (that half of
  the SVG disqualification does not apply here), and entities decode correctly
  (`&amp;&#20320;` → `&你`).
- **Presentation conventions researched** (MBB / consulting practice): action titles that
  read as a storyline when stacked (*horizontal logic*), one idea per slide, an asymmetric
  ~60/40 two-column grid rather than 50/50, a "so what" per exhibit, and a restrained
  palette. These map onto schema fields and an advisory lint, not documentation.
- **`pptx-automizer` exists** (template-driven .pptx, wraps pptxgenjs) and is the charted
  answer if corporate-template import is ever wanted. Bun compatibility unprobed. Out of
  scope by decision.

## Tickets

Phase 1 — the seam
- `tickets/01-slide-model-and-theme.md` — task — types + tokens + type scale
- `tickets/02-layouts.md` — task — six pure `Slide → PlacedBlock[]` functions + goldens

Phase 2 — emitters
- `tickets/03-emit-pptx.md` — task — blocks → native shapes / wrapping text boxes
- `tickets/04-emit-html.md` — task — blocks → self-contained composed HTML

Phase 3 — wiring
- `tickets/05-deck-build-rewrite.md` — task — orchestrator, CLI, tool, **compat lock**

Phase 4 — validity
- `tickets/06-ooxml-lint.md` — task — structural gate + `Bun.XML` order receipt
- `tickets/07-deck-lint.md` — task — advisory storyline / one-idea-per-slide checks

Phase 5 — surface
- `tickets/08-docs-and-example.md` — task — README, SKILL, a composed example deck

## Decisions

Recorded in full in `spec.md` §3 (D1–D7). The three that shaped the architecture:

- **D2 — boxes, never glyph metrics.** A block declares a box; PowerPoint and CSS each wrap
  inside it. This is what lets the package stay browser-free *and* get CJK right, and it is
  why layouts return fractions instead of text extents.
- **D3 — compatibility by inference.** `ir` and no `layout` ⇒ `layout: "diagram"`, whose
  geometry is today's to the coordinate. The example manifest must build unchanged, to the
  same counts.
- **D6 — the parser split follows the measurement.** `Bun.XML` for order-insensitive checks
  and for `spPr` (distinct children ⇒ key order is document order); `HTMLRewriter` for the
  `a:path` segment check, which is precisely what `Bun.XML` destroys.

## Frontier

Phase 1 next.

## Fog of war

- **`<iframe>` inside webui's `/files` CSP** (`sandbox allow-scripts allow-downloads`) is
  unprobed for a *nested* same-directory document. Sandbox flags are inherited, so it should
  render; if it does not, the fallback is inlining the artifact's `<svg>` + `<style>` into the
  composed page, which trades interactivity for certainty. Only `split` is affected —
  `diagram` slides do not go through the composed HTML path at all (D4).
- **Full ECMA-376 XSD validation** is deliberately uncharted as a permanent gate (D5); the
  one-off receipt is the charted substitute.
- **Text overflow on a composed slide** is now PowerPoint's problem rather than ours, but
  `fit: 'shrink'` shrinking a 16 pt body to 9 pt is a legibility failure the lint cannot see.
  No metric for it without a layout engine.

## Cross-effort links

- **Builds-on**: `.planning/2026-08-21-archify-view-pptx-bun` — its ShapeIR seam (D1),
  `HTMLRewriter` parser choice (D2) and native-shape PPTX path are the foundation here.
  Its D2 write-up is **corrected, not overturned**, by this effort's finer A/B (see Context).
  Its fog entry on text metrics is the problem D2 here sidesteps.
