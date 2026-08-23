---
effort: 2026-08-23-archify-rich-decks
created: 2026-08-23
last: 2026-08-23
status: active
---
# archify-rich-decks — faster, richer pptx authoring through a copy-adapt IR library

## Destination

Authoring a pptx with `s2-agent-ext-archify` becomes copy-adapt instead of write-from-scratch:
a cataloged IR library (~15 validated rich IRs + a harvested real-world tier), one flagship
library deck weaving those IRs with the 7 rich template results into a single coherent
argument, surfaced by `archify_deck_lint` (no-args catalog), gated by a test — and, in
phases 2–4, a mermaid→IR converter, `ir`-capable layout templates, and a quality sweep.
Build speed is a non-target (it is already 0.15 s); speed means tokens and authoring turns.

## Context (measured 2026-08-23 on this machine, bun 1.4.0)

- **Build is not the bottleneck.** `bun run deck examples/deck-general/deck.config.json`
  → **0.152 s** total, 12 slides, 241 native shapes, 277 KB, 0 images. "Speed" must mean
  authoring cost, not wall-clock.
- **The IR library is tiny.** Exactly 7 authored IRs exist in the package:
  `examples/deck/ir/slide1-5.json` (5) + `examples/minimal.architecture.json` +
  `examples/vmodel/chip-vshape.architecture.json`. Five diagram types exist; only 1–2
  archetypes per type are demonstrated.
- **Rich template results exist and are proven.** 7 data templates (`agenda`, `compare`,
  `end`, `kpi-row`, `quote`, `table`, `timeline`) + 6 code layouts, all demonstrated
  filled-to-the-brim by `examples/deck-general/` (the archived `general-deck` effort,
  `status: complete`). **No template has an `ir` slot** — templates are text-only; IR
  diagrams enter a deck only via the `diagram`/`split` code layouts.
- **Real production decks barely use the rich set.** The delivered
  `/Users/huangziyu/proj/output/archify-aspice4-v5/deck.config.json`: 25 slides —
  `title` 1, `section` 4, `bullets` 4, `diagram` 11, `statement` 4, `table` 1. Eleven
  hand-authored IRs, one template used, four rich templates never touched.
- **No mermaid→IR converter exists.** Mermaid appears only in the test fixtures of
  `src/architecture-render.ts`; the vendored SKILL.md § "Mermaid as an Input Dialect" is
  documentation for hand-conversion, not tooling.
- **The catalog reporting surface already exists.** `archify_deck_lint` with no manifest
  returns the layout catalog + deck skeletons (`src/deck-lint-tool.ts`, D9 discovery
  surface) — the IR library slots into the same no-args surface; no new tool needed
  (schema-cost canary rule).
- **Suite is green and large** — 38 test files under `tests/` (deck-skeletons,
  real-result, role-color, e2e, …); `bun run test` is the canonical gate.

## Tickets

Phase 1 — copy-adapt IR library (this session)
- `tickets/10-ir-library.md` — task, **open** — ~15 validated IRs + catalog + flagship deck + gate
- `tickets/11-docs-and-discovery.md` — task, **open** — lint catalog reporting, README/SKILL/docs index

**Execution order:** 10 → 11 (fully forced: 11 `blocking: 10`)


Phase 2 — authoring-flow tooling
- `tickets/20-mermaid-converter.md` — task, **open** — mermaid → validated IR console step

Phase 3 — richer templates
- `tickets/30-ir-slot-in-templates.md` — task, **open** — `ir`-capable drawing primitive in layout templates + 2–3 new rich templates

Phase 4 — quality fidelity sweep
- `tickets/40-quality-sweep.md` — task, **open** — re-run the visual-fidelity gates against the library + benchmark deck

## Decisions

- **D1 — speed = authoring tokens/turns, not build wall-clock.** 0.152 s build measured;
  the lever is fewer hand-authored IRs per deck. Everything in this effort serves that.
- **D2 — the library is hand-authored, not generated.** It is part 1; the mermaid
  converter is part 2 and must not be on the critical path.
- **D3 — one coherent narrative spine.** All ~15 IRs + the flagship deck use the existing
  resolver/cold-start world (same dataset as `deck-general`/`examples/deck`), so every IR
  interlocks with the rich template results (dataflow IR ↔ kpi-row slide ↔ timeline).
- **D4 — catalog is data, reported by an existing tool.** `library.catalog.json` is the
  typed index; `archify_deck_lint` (no args) reports it as a new section. No new tool.
- **D5 — zero behavior change to existing decks.** Library IRs appear only in new
  manifests; existing examples stay byte-identical; D3 lock holds.
- **D6 — phases in order 1→4.** Richer templates touch both emitters (riskiest) so they
  come after the library proves the standard; quality sweep closes.

## Frontier

`tickets/10-ir-library.md` — the ~15 validated IRs and the flagship library deck. First
because it is the biggest single token win per slide and is pure additive (D5), so it fits
this session end-to-end through its gate.

## Fog of war

- The exact 15-IR list (which archetypes map to which type) is pinned in `spec.md` §4 but
  not yet validated against the schema — expect 2–3 authoring iterations per IR.
- Harvest tier: up to 3 real chip/ASPICE IRs from `~/proj/output/archify-aspice4-v5` are
  folded in as a flagship-domain archetype; they must be re-audited against the cardinal
  rule (no inline hex) since shipping does not imply catalog-pinned quality style.
- How the no-args lint text renders CJK descriptions inline is a formatting judgment; the
  test pins fields, not prose style.
- Phase 2 converter dialect coverage (which mermaid features map cleanly to the 5 schemas)
  is deliberately uncharted until phase 2 starts.
- Whether the flagship deck replaces `deck-general` as the canonical example: **no** —
  deck-general stays canonical; the library deck is the copy-adapt resource (D3).

## Cross-effort links

- **Builds-on**: `.planning/archive/2026-08-22-archify-general-deck` — its templates,
  skeleton-discovery tiers and catalog reporting are the surface this effort extends
  (D4); its archived `tickets/11-self-contained-output.md` is unrelated to this effort's
  scope (that ticket lives on in the next-goal queue, not here).
- **Builds-on**: `.planning/archive/2026-08-21-archify-slide-composition` — the
  `PlacedBlock` seam and D3 byte-identity lock constrain phase 3 (an `ir` slot must not
  disturb the `diagram` layout's frozen coordinates).
- **Builds-on**: `.planning/archive/2026-08-21-archify-deck-visual-fidelity` — its
  measured defects (title band wrap, takeaway placement) are the checklist phase 4 re-runs
  against new library content.
