---
type: task
status: open
---

# 10 — Copy-adapt IR library: ~15 validated IRs + catalog + flagship deck + gate

## Question
Author a pptx with archify by copying ready validated IRs instead of writing each from
schema memory.

## What to build

`bun-apps/s2-agent-ext-archify/examples/ir-library/` contains a cataloged, validated,
rendered IR library — 12 generic archetype IRs (5 diagram types × 2–3 archetypes) plus up
to 3 harvest-tier real chip IRs — all in the existing resolver/cold-start narrative world
so IRs and rich template results interlock; a `library.catalog.json` typed index; and one
flagship library deck (`decks/library.config.json`, ~19 slides) weaving the IRs with the 7
rich template results into one coherent argument. Every IR has gone through the same
`deliver` path as any other (validate → render); nothing in the package's existing
examples, layouts or emitters changes.

## Acceptance

- [x] `examples/ir-library/` holds 12 generic IRs (each diagram type covered by ≥2
      archetypes) + 3 harvest-tier real chip IRs (re-audited: no inline hex); every IR
      declares its own `meta.output`.
- [x] Every cataloged IR passes `validate()` and renders via `deliver` (HTML artifact
      produced, exit 0).
- [x] `library.catalog.json` lists all 15 IRs: path (relative), diagram_type, title,
      description, archetype, pairing, tier; no duplicate paths; `diagram_type` values match
      the IR files' own declarations.
- [x] `decks/library.config.json` builds (21 slides, 1159 native shapes, 0 images): 0 fatal
      deck-lint diagnostics, **0 `<a:blip>`** in every slide, and all 7 rich template
      results appear ≥1 slide each.
- [x] `tests/ir-library.test.ts` green (19 tests: catalog well-formedness, catalog↔IR
      type match, per-IR validate+deliver, flagship deck builds clean, templates covered).
- [x] No existing example or source file changes; `examples/deck` D3 lock untouched (suite
      compat tests pass).
- [x] Full `bun run test` green: 648 pass / 21 skip / 0 fail; `bun run typecheck` clean.

## Resolution

Shipped on branch `archify-rich-decks-ir-library` (PR pending): the 15-IR copy-adapt
library, `library.catalog.json`, the 21-slide flagship deck, and the `ir-library.test.ts`
gate. All IRs authored against the vendored per-mode vocabulary; coordinate diagnostics
fixed by following the validator's `supportedFixes` (labelAt / fromSide+toSide / via).
closed: 2026-08-23 (implemented)
