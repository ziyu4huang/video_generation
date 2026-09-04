---
effort: 2026-08-23-archify-rich-decks
created: 2026-08-23
last: 2026-09-04
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
- **Suite is green and large** — 54 test files under `tests/` (deck-skeletons,
  real-result, role-color, e2e, ir-library, …); `bun run test` is the canonical gate
  (measured 54 at `a246efce`).

## Tickets

Phase 1 — copy-adapt IR library (this session)
- `tickets/10-ir-library.md` — task, **closed** — 15 validated IRs + catalog + flagship deck + gate
- `tickets/11-docs-and-discovery.md` — task, **closed** — lint catalog reporting, README/SKILL/docs index

**Execution order:** 10 → 11 (fully forced: 11 `blocking: 10`)


Phase 2 — authoring-flow tooling
- `tickets/20-mermaid-converter.md` — task, **closed** — mermaid → IR converter: all 5 schemas, convert+validate one call (design spec.md §7.1; PR #1943)

**Execution order:** 20 (single ticket, fully forced — closed 2026-08-24)

Phase 3 — richer templates
- `tickets/30-ir-slot-in-templates.md` — task, **closed** — `ir` slot as a first-class template binding + 3 new rich templates (decision / timeline-with-diagram / figure; PR #1950)

**Execution order:** 30 (single ticket, fully forced — closed 2026-08-24)

Phase 4 — quality fidelity sweep
- `tickets/40-quality-sweep.md` — task, **closed 2026-09-04** — 4 template defects fixed + `statement-overflows` gate; receipt `archify-quality-sweep-2026-09-04.md`

**Execution order:** 40 (single ticket, fully forced; design-first)

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
- **D7 — the converter is a mechanical subset, not judgment.** The vendored doc says
  "you choose grouping, lane order, and what deserves emphasis — that judgment is the
  product"; automating judgment (invented lane grouping, clever typing) is the fastest
  path to valid-but-wrong IRs. The converter owns only the mechanical grammar→structure→schema
  step; the judgment happens AFTER, in the copy-adapt step (D2). Any recognized-but-unbounded
  syntax is a hard error, never a best-effort guess.
- **D8 — dataflow via convention, ours until upstream.** Mermaid has no documented
  dataflow mapping, and dataflow's schema is the most opinionated (stages 2–5, mandatory
  flow labels); subgraph → stage + `to <targetLabel>` defaults is the phase-2 convention,
  documented in the design and `--help`, to be reconciled if upstream ever maps dataflow.
- **D9 — the converter ships as a CLI script, not an extension tool.** A `defineTool`
  costs tool-description tokens in EVERY session (schema-cost canary) for a rare authoring
  step; a documented `bun run mermaid:convert` + SKILL.md wiring is free and matches D4's
  no-new-tool precedent. The agent reaches it via a shell step, exactly like `bun run deck`.

## Frontier

cleared — ticket 40 closed 2026-09-04. The sweep re-ran the fidelity gates over the
HTML/SVG twins (quicklook judged insufficient; stage-exact Bun.WebView captures) and the
benchmark deck; four template-layer defects are fixed and one new error-severity gate
(`statement-overflows`) folded back. Effort complete: phases 1–4 all closed.

## Fog of war

- The exact 15-IR list (which archetypes map to which type) is pinned in `spec.md` §4 but
  not yet validated against the schema — expect 2–3 authoring iterations per IR.
- Harvest tier: up to 3 real chip/ASPICE IRs from `~/proj/output/archify-aspice4/` (the
  11-slide 2026-07-08 rerun — chip-scope, chip-vmodel, tapeout-cycle; the 25-slide
  `archify-aspice4-v5/` folder is a different deck and holds none of them) are folded in as
  a flagship-domain archetype; they were re-audited against the cardinal rule (no inline
  hex) and verified byte-identical to their sources.
- How the no-args lint text renders CJK descriptions inline is a formatting judgment; the
  test pins fields, not prose style.
- Phase 2 converter dialect coverage is now designed (spec.md §7.1, 2026-08-24): the
  bound is all 5 schemas via 3 dialects + `--type`, with the D8 dataflow convention.
  Residual unknowns: exact label-clearance tuning against the vendored composition checker
  is resolved at implementation (the gate is validate-green, not a fixed layout constant);
  whether the converted output's auto layout feels like good copy-adapt material is an
  authoring-time judgment, not a converter bug.
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
