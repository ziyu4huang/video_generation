# Spec — archify deck template v2

Effort: `2026-08-22-archify-deck-template-v2` · Builds-on: `2026-08-21-archify-slide-composition`

## 1. Problem

The ASPICE 4.0 v2 deck (`aspice4-chip-v2.pptx`) proved four deck-template capabilities
that archify has no first-class support for. Every one was hand-crafted around the
template:

1. **Arm coloring** — blue/green spec side vs red/amber verify side had no semantic
   field; `variant` carries visual emphasis, not domain side.
2. **The V shape** — hand-computed `pos`/`size` on every component.
3. **Guided views** — `meta.views` render as interactive HTML buttons but never reach
   the pptx; page 5 is a single static V.
4. **Arrow dual meaning** — solid = derivation, dashed = verification pairing; the
   convention exists in nobody's documentation and no legend is generated.

## 2. Requirements

### R1 — `role` semantic color field (ticket 01)

- Optional `role` on components and connections, enum `{ spec, verify }`.
- `role` maps to theme color via the existing theme pipeline (svg-theme + pptx color
  map); never an inline color. `role` overrides componentType-derived color when
  present; `variant` composes independently (dashed/emphasis still apply).
- Absent `role` ⇒ rendering bit-for-bit unchanged.

### R2 — `v-model` archetype (ticket 02)

- Optional `meta.archetype: "v-model"` plus a payload declaring ordered `leftArm` /
  `rightArm` node-id lists and `crossbars` (pairs of node ids).
- A pre-pass fills `pos`/`size` for nodes that lack them: two slanted arms meeting at
  the bottom apex, crossbar endpoints interpolated. Explicit positions are never
  overridden. Unknown archetype value ⇒ validate error. Unknown node id in a list ⇒
  validate error.

### R3 — guided views into pptx (ticket 03)

- A diagram/split slide accepts optional `"views": "expand"`.
- Expansion produces 1 overview slide + 1 slide per `meta.views` entry. Per-view
  slides: title = view `label`, takeaway = view `note`, focus members full color,
  non-focus dimmed (pptx shape transparency). A view referencing an unknown node id ⇒
  deck-lint diagnostic.
- HTML interactive views unchanged.

### R4 — arrow dual-meaning convention + auto legend (ticket 04)

- SKILL.md (condensed + vendored) documents: **solid = derivation/flow; dashed =
  verification pairing / cross-reference**.
- When an IR mixes ≥2 connection variants, render (HTML + pptx) emits a small legend
  card (line samples + meanings). `meta.legend: false` disables. Single-variant IRs
  produce no legend (baseline unchanged).

### R5 — v2 recast acceptance (ticket 05)

- Rewrite `chip-vshape.architecture.json` using archetype + role (+ views expand in the
  deck manifest), rebuild the deck, and verify: page-5 V visually equivalent to v2
  (arms, apex, crossbars, coloring), suite green, legacy manifests byte-identical.

## 3. Non-goals

- Pyramid/cycle/loop archetypes; role vocabulary beyond `{spec, verify}`; automated
  legibility gate; HTML renderer interaction changes.

## 4. Compatibility bar

Every ticket lands additive-only: new optional schema fields, new opt-in manifest
flags. The slide-composition baseline (401 passing / 0 failing; example deck builds
byte-identical) must hold after each ticket — checked in that ticket's tests, not
deferred to 05.
