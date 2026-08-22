# archify-deck-template-v2 — 2026-08-22

Effort: `.planning/2026-08-22-archify-deck-template-v2/` (tickets 01-05, all closed).
Source lesson: the ASPICE 4.0 v2 deck session — four deck-template capabilities that
deck had to hand-craft.

## Delivered

| Capability | Seam | Tests |
|---|---|---|
| `role ∈ {spec, verify}` semantic colors | `common.schema.json` `$defs.role` → `c-/t-/a-/m-role-*` classes in `vendored/assets/template.html` + `lib/svg-theme.ts` `CLASS_RULES`/`THEME_VARS`; renderer picks role over componentType, role overlays variant | `__tests__/role-color.test.ts` |
| `meta.archetype: "v-model"` geometry | `vendored/renderers/architecture/vmodel.mjs` IR→IR pre-pass (fills absent pos/size from arm lists; explicit pos wins), wired before measurement in `render-architecture.mjs` | `__tests__/vmodel-archetype.test.ts` |
| `"views": "expand"` deck builds | `lib/view-focus.ts` (inline-`opacity` dimming on the parsed SVG — the one channel `applyInlineAttrs`→`pptx-shapes` already carries) + `expandViews()` in `lib/deck-build.ts`, expansion BEFORE lint | `__tests__/views-expand.test.ts` |
| Arrow dual-meaning + legend | SKILL.md (condensed + vendored) convention; opt-in `meta.legend: "variants"` line-sample legend in `renderLegend()` | `__tests__/arrow-legend.test.ts` |
| v2 recast acceptance | `examples/vmodel/` (IR with zero hand-computed geometry + manifest) | `__tests__/vmodel-example.test.ts` |

## Measured

- Suite **505 → 525 passing / 0 failing**; `tsc --noEmit` clean.
- Recast deck: 6 slides (title + overview + 3 guided builds + statement), 499 native
  shapes, 379 KB; pptx dimming alpha counts per slide: overview 0, spec-arm 12,
  verify-arm 19, pairings 5.
- v2-equivalence eyeballed side-by-side (screenshots in the session): 10 nodes /
  12 connections / 3 crossbars / tape-out / 3 guided views all preserved; the recast
  is a TRUE slanted V (v2's straight columns were the old template's compromise).
- One IR-authoring fix surfaced by the layout gates: the archetype's 60px apex gap
  cannot hold the 140px "tape-out" label — `labelDy: 50` per the diagnostic's own
  suggestion. Everything else passed first try.

## Traps hit (and fixed in-flight)

1. **Auto variant legend broke the D3 byte-lock** — `examples/deck/ir/slide{2,3}.json`
   mix connection variants, so default-on legend rows changed the legacy deck's shape
   counts. Resolution: opt-in `meta.legend: "variants"` (map D7); the role legend
   stays automatic because roles cannot exist in pre-effort IRs.
2. **`gap` was centre-distance** — 150px nodes 60px apart centre-to-centre overlap by
   90px; redefined as edge clearance.
3. **Right-arm row/lerp inversion** — rightArm[0] is the apex-MATE (bottom), not the
   top; the first cut placed the V's right arm upside down.
4. **Valueless attrs (`data-legend-bridge`) don't survive `parseSvg`** — tests must
   assert on value-bearing attrs (`data-legend-kind`).
5. **Golden regen is legitimate when the template itself changes**: the role CSS lives
   inside the self-contained HTML, so `mini.architecture.html` HAD to move. The diff
   was audited line-by-line to contain only the additive CSS before copying.
