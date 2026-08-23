# archify-rich-decks spec — §1 copy-adapt IR library (design v1)

Date: 2026-08-23 · Status: active · Effort: `.planning/2026-08-23-archify-rich-decks/`

## 1. Problem

Authoring a pptx with `s2-agent-ext-archify` today means hand-writing each IR JSON
(validate → render → iterate). Real delivery evidence — `archify-aspice4-v5`,
25 slides, 11 hand-authored IRs, 1 template used — shows the rich template set barely
appears in production decks while authoring cost dominates. Build wall-clock is not the
problem: a 12-slide mixed deck builds in **0.152 s** (measured 2026-08-23).

Speed = fewer tokens and authoring turns per deck. The lever: **copy-adapt resources** —
ready, validated, rich IRs that an agent duplicates and edits, instead of writing from
schema memory.

## 2. Goals

- A cataloged IR library, ~15 IRs: 5 diagram types × 2–3 archetypes, all validated and
  rendered, in one coherent generic narrative (resolver/cold-start world) so IRs and rich
  template results interlock.
- A flagship library deck (~19 slides) that weaves those IRs with the 7 rich template
  results into one argument — the strongest copy-adapt artifact (the manifest shape itself
  is shown filled).
- A harvest tier: up to 3 real shipped IRs from `~/proj/output/archify-aspice4/`
  (the 11-slide 2026-07-08 rerun — `chip-scope`, `chip-vmodel`, `tapeout-cycle`;
  NOT the 25-slide `archify-aspice4-v5` folder, which holds a different deck)
  re-audited against the cardinal rule (no inline hex) and folded in as the
  flagship-domain archetype set.
- Discovery: `archify_deck_lint` (no args) reports the library; docs index it. No new tool.
- A permanent gate: `tests/ir-library.test.ts` pins every cataloged IR to validate+render
  and the flagship deck to 0 fatal lint / 0 blips.

## 3. Non-goals (this ticket)

- Mermaid→IR converter (phase 2), `ir` slot in layout templates (phase 3), quality sweep
  (phase 4) — all carried in the effort ticket queue, not here.
- No changes to existing examples, layouts, emitters, or the D3 byte-identity lock.
- No new tool entry; no registry changes beyond nothing.

## 4. Design

### 4.1 Directory structure

```
bun-apps/s2-agent-ext-archify/examples/ir-library/
  library.catalog.json          # typed index (see 4.3)
  architecture/
    soctopology.architecture.json       # archetype: system inventory (SoC: APU/ISP/NoC bounds)
    service-topology.architecture.json  # archetype: distributed system w/ boundaries
    req-chain.architecture.json         # archetype: V-model req chain (MRD→SAS→MAS→RDS)
  workflow/
    change-approval.workflow.json       # archetype: decision/verified approval path
    cd-pipeline.workflow.json           # archetype: CI/CD stages w/ branch
    incident-response.workflow.json     # archetype: incident response (decision + escalation)
  sequence/
    request-lifecycle.sequence.json     # archetype: cold-start request lifecycle
    cold-path-walk.sequence.json        # archetype: trace a cold request across components
  dataflow/
    etl-pipeline.dataflow.json          # archetype: ETL/lineage
    trace-pipeline.dataflow.json        # archetype: telemetry pipeline
  lifecycle/
    feature-state.lifecycle.json        # archetype: feature state machine
    tapeout-states.lifecycle.json       # archetype: tapeout states/transitions
  tiers/
    chip-scope.architecture.json        # harvest: real chip IR (SOA audit, cardinal rule)
    chip-vmodel.dataflow.json           # harvest: real chip V-model dataflow
    tapeout-cycle.sequence.json         # harvest: real chip tapeout sequence
  decks/
    library.config.json                 # the flagship deck
```

The `tiers/` dir is not a mechanism — it's a convention placing real-world IRs apart from
generic archetypes so an agent reaching for a "professional chip deck" finds them, while the
generic set stays copy-adaptable. Exact archetype list is final at authoring time; the
count (≥15 including the harvest tier; ≥12 generic) is the binding target.

### 4.2 Content spine

All IRs use the resolver/cold-start narrative that `examples/deck` and `examples/deck-general`
already speak (a search-resolver cold path, p99 4.2 s, migration quarters Q1–Q4, pipeline
stages); no new world is invented. Concretely:

- `trace-pipeline.dataflow.json` IS the resolver pipeline whose numbers the `kpi-row`
  slide states (4.2 s → 1.8 s → 38 % hit rate).
- The `timeline` template result is the migration quarters the
  `feature-state`/`tapeout-states` lifecycles model.
- The `table` template result shows the per-service p99/p50 the `service-topology`
  architecture diagram's components measure.

Editorial rules: field names/action titles per consulting practice (claim, not label);
allowed vocabulary only — `componentType` / `variant` / `role` for semantic color,
**zero inline hex** (Cardinal Rule); `meta.legend` only where ≥2 connection variants are
mixed; every IR declares `meta.output` under its own name and never under an existing
example's path.

### 4.3 `library.catalog.json`

The single typed index. One entry per IR:

```json
{
  "entries": [
    {
      "path": "architecture/service-topology.architecture.json",
      "diagram_type": "architecture",
      "title": "Service topology: resolver + caches behind one boundary",
      "description": "Five services, two boundaries, one external. Copy for any boxed system diagram.",
      "archetype": "distributed-system",
      "pairing": ["kpi-row", "timeline"],
      "tier": "generic"
    }
  ]
}
```

- `path` relative to `library.catalog.json`; `tier` ∈ `generic|flagship-domain`;
  `pairing` is the suggested-pairing hint (recommended template names, e.g. "pair with
  `kpi-row` to state the measured impact") — advisory lint feed, never authoritative.
- Well-formedness (duplicate paths, wrong `diagram_type` vs the IR's own declaration,
  missing files) is asserted by the gate (6.2).

### 4.4 Flagship deck `decks/library.config.json`

~19 slides, one argument: cold-path latency → why it matters → what is in the path →
how many queues/states → the race → the decision. Composition principle: every rich
template result appears at least once, each paired near the IR it measures; the deck is
**not** a second `deck-general` — it is the IR world's deck, and `deck-general` remains the
canonical template-showcase example (D3).

Slide plan (final at authoring): title → 3× architecture (topology, service, req-chain) →
dataflow (trace) + kpi-row → workflow (approval) + agenda → sequence (request lifecycle) →
compare (self-host vs managed) → lifecycle (feature state) → timeline → sequence
(tapeout) → statement → table → split (service-topology + bullets) → end. Exact order is
an authoring decision; the test pins counts, not order.

### 4.5 Discovery & docs

- `archify_deck_lint` (no manifest): the existing no-args catalog gains an "IR library"
  section read from `library.catalog.json` — per entry: `diagram_type` · title ·
  description · suggested pairing · path (relative to the package root for copy). No new
  tool (schema-cost canary); no change to the manifest-mode behavior.
- `README.md` + `skills/archify/deck.md`: a pointer paragraph — "copy-adapt library at
  `examples/ir-library/library.catalog.json`; `archify_deck_lint` lists it".
- `skills/archify/SKILL.md`: on-demand depth list gains the library path.

### 4.6 Gate — `tests/ir-library.test.ts`

1. Catalog well-formedness: every `path` exists, is unique, `diagram_type` matches the
   IR's own `diagram_type` field, `tier` value valid, `description`/`title` non-empty.
2. Every cataloged IR: `validate()` passes; render via the `deliver` path into a temp dir
   succeeds and the artifact exists.
3. Flagship deck: `buildDeck` succeeds → 0 fatal lint, **0 `<a:blip>`** in every slide.
4. Register in the canonical suite: `bun run test` picks it up as `tests/ir-library.test.ts`
   (glob-glued), no package.json script change needed.

## 5. Verification (Done when)

- [x] ≥12 generic + ≥2 harvest IRs, all validate + render clean via `deliver`.
- [x] Library deck builds: 0 fatal lint, 0 blips, all 7 rich templates present ≥1 slide.
- [x] `archify_deck_lint` no-args output includes the IR library section.
- [x] `tests/ir-library.test.ts` green; full `bun run test` green in `s2-agent-ext-archify`.
- [x] Existing examples untouched, `examples/deck` byte-identical build (D5).
- [x] Docs updated (README + deck.md + SKILL.md pointer).

> Shipped 2026-08-23 on `archify-rich-decks-ir-library` (t10 + t11 closed). Authoring-time
> name drift from §4.1/§4.4: `soctopology` → `system-inventory` (generic inventory
> archetype), generic `tapeout-cycle` → `cold-path-walk` (sequence) + `release-states`
> (lifecycle), and the tier `tapeout-cycle` appears only in the catalog — the flagship deck
> stays resolver-world and does not include tier IRs.

## 6. Decisions recorded in the map (`## Decisions`, D1–D6)

See `map.md`. The two that matter most here: D2 (hand-authored, not generated — the
converter is phase 2) and D5 (zero behavior change to existing decks — the library is pure
addition).

## 7. Phase plan beyond this ticket (queue, not scope)

- **Phase 2**: mermaid → IR converter as a CLI step (convert + validate in one call) over
  the vendored "Mermaid as an Input Dialect" docs; wire it into the authoring loop docs.
- **Phase 3**: `ir` slot as a new template drawing primitive (`BlockContent.kind` +
  per-primitive emitters) without touching the `diagram` layout's frozen geometry; plus
  2–3 new rich templates (e.g. `decision`, `timeline-with-diagram`).
- **Phase 4**: re-run `archify-deck-visual-fidelity`'s measured checks (title band wrap,
  takeaway placement) against the library deck and the benchmark `aspice4-chip-v5`; fix
  and fold back as gates.
