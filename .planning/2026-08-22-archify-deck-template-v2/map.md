---
effort: 2026-08-22-archify-deck-template-v2
created: 2026-08-22
last: 2026-08-22
status: complete
---

# archify-deck-template-v2 — deck template lessons from the ASPICE v2 deck

## Destination

The four deck-template capabilities the ASPICE 4.0 v2 deck had to hand-craft become
first-class archify features: a `role` semantic color field, a `v-model` geometry
archetype, `meta.views` expansion into pptx guided-build slides, and the solid/dashed
arrow dual-meaning convention with an auto legend. Accepted by recasting the v2 deck
through the new template with page-5 equivalence, on a bit-for-bit-preserved baseline.

## Context (measured 2026-08-22 on this machine)

- **The v2 deck's V-IR hand-dodged every gap** (`/Users/huangziyu/proj/output/archify-aspice4-v2/chip-vshape.architecture.json`):
  10 components all `variant: "default"` with hand-computed `pos`/`size`; 12 connections
  (8 default, 1 emphasis, 3 dashed crossbars); arm coloring (blue/green spec vs
  red/amber verify) had no semantic field to live in — `variant ∈ {default, emphasis,
  security, dashed}` carries visual emphasis, not domain side.
- **`meta.views` exists only in the vendored HTML renderer.** The pptx pipeline
  (`lib/deck-build.ts` → `lib/shape-ir.ts` → `lib/pptx-shapes.ts`) has zero views
  awareness — the 3 guided views (spec-arm / verify-arm / pairings) never reached the
  deck.
- **v1's core miss was type selection by content semantics** ("process flow" → dataflow)
  instead of by the shape being described (a literal V) — recorded in the session
  reflection; the shape-first selection rule belongs in the skill, the V shape itself
  belongs in the template.
- **Baseline**: slide-composition effort closed 2026-08-21 with 401 passing / 0 failing
  and byte-identical legacy slide XML; that compatibility bar is inherited here.

## Tickets

Phase 1 — IR vocabulary (independent of each other)
- `tickets/01-role-semantic-color.md` — task, **closed** — `role` field + theme mapping
- `tickets/02-vmodel-archetype.md` — task, **closed** — `meta.archetype: "v-model"` geometry pre-pass

Phase 2 — deck composition
- `tickets/03-views-into-pptx.md` — task, **closed** — `"views": "expand"` slide expansion
- `tickets/04-arrow-legend.md` — task, **closed** — dual-meaning convention + legend (opt-in, D7)

Phase 3 — acceptance
- `tickets/05-v2-recast.md` — task, **closed** — recast shipped as `examples/vmodel/` + E2E test

## Decisions

- **D1 — new `role` field, not a `variant` extension.** `variant` is visual emphasis
  (emphasis/dashed); domain side (spec/verify) is orthogonal and must compose with it
  (a dashed verify crossbar = `role: "verify"` + `variant: "dashed"`). Widening the
  `variant` enum would also be a schema break for existing validators.
- **D2 — archetype as an IR→IR geometry pre-pass.** `meta.archetype` fills absent
  `pos`/`size` from arm/crossbar lists; explicit positions are never overridden. Both
  render paths (vendored HTML, lib pptx) consume the enriched IR, so no renderer forks.
- **D3 — additive-only fields, bit-for-bit baseline.** Every new field is optional and
  inert when absent; the slide-composition compatibility bar (legacy manifests build
  byte-identical) must survive each ticket.
- **D4 — v-model only.** Pyramid/cycle archetypes are Fog of war until a second real
  deck asks for them.
- **D5 — views expand = 1 overview + N build slides.** The deck mirrors the HTML guided
  views as progressive static builds (focus full-color, rest dimmed via pptx
  transparency); view `label`→slide title, `note`→takeaway. Dimming rides the ONE
  channel the pipeline already carries — an inline `opacity` attr on the parsed SVG
  (`applyViewFocus`), which `applyInlineAttrs` reads and `pptx-shapes` maps to
  transparency — so the on-disk artifact stays the untouched interactive page (D4 of
  the slide-composition effort).
- **D6 — crossbars are ordinary connections, not archetype payload.** Verification
  pairings need no geometry help once the archetype places the arms (default side
  anchors + `route: "straight"` produce the horizontal pairing arrows), so the
  payload ships arms only — less schema, more author control.
- **D7 — variant legend is OPT-IN (`meta.legend: "variants"`), not automatic.**
  Auto-on broke the inherited D3 byte-lock within this same effort:
  `examples/deck/ir/slide2.json` and `slide3.json` mix variants, so a default-on
  legend changed the legacy deck's shape counts. The role legend stays automatic —
  roles cannot appear in pre-effort IRs.

## Frontier

cleared — tickets 01-05 all closed 2026-08-22.

Delivered: `role ∈ {spec, verify}` painting both render paths through the theme;
`meta.archetype: "v-model"` placing a literal V from arm lists (explicit pos always
wins); `"views": "expand"` turning `meta.views` into pptx guided-build slides; the
solid/dashed dual-meaning convention documented with an opt-in line-sample legend;
and the ASPICE v2 deck recast as `examples/vmodel/` with ZERO hand-computed geometry
(one `labelDy` tweak on the tape-out label — the 60px apex gap cannot hold a 140px
label), guarded by `__tests__/vmodel-example.test.ts`. Suite went **505 → 525
passing, 0 failing**; the legacy deck's byte-identical lock held throughout (one
deliberate golden regen for the role CSS embedded in `mini.architecture.html`).

## Fog of war

- Pyramid / cycle / loop archetypes — charted, rejected by D4 until demanded.
- Role vocabulary beyond `{spec, verify}` — keep the enum closed until a real deck
  needs a third side.
- Auto legibility gate (render → 175% zoom screenshot → collision check) — the v2 loop
  did this by eye; automating it is a separate effort if it recurs.
- Archetype `gap`/`size` are global per-IR; per-node overrides are nothing more than
  authored `pos`/`size`, so no extra vocabulary was added — revisit only if a real V
  needs mixed node sizes on one arm.
- The `.planning/knowledge/archify-shape-first.md` skill candidate from the v2 session
  never landed in this repo (other runtime's memory) — the shape-first rule now lives
  where it acts: SKILL.md's type-selection + archetype guidance.

## Cross-effort links

- **Builds-on:** `2026-08-21-archify-slide-composition` — inherits its layouts/theme
  model, test baseline (401 passing), and the bit-for-bit compatibility bar (its D3).
