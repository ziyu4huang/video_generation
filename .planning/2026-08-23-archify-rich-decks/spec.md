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

### 7.1 Phase 2 — mermaid → IR converter (design v1, 2026-08-24)

A deterministic line-based converter: paste mermaid → copy-adaptable, **valid** IR. It
implements the mechanical subset of the vendored "Mermaid as an Input Dialect" mapping
(`vendored/SKILL.md` §); the judgment the doc reserves for the human ("you choose
grouping, lane order, and what deserves emphasis") happens AFTER conversion, in the
copy-adapt step (D2/D7). Covering all 5 schemas (D8 for dataflow).

#### 7.1.1 Coverage bound — dialect × schema matrix

| Mermaid dialect | `--type` | IR schema | Mapping source |
|---|---|---|---|
| `flowchart` / `graph` | `workflow` (default) | workflow | vendored: flowchart → workflow |
| `flowchart` / `graph` | `architecture` | architecture | vendored: "or architecture if it's a component map" |
| `flowchart` / `graph` | `dataflow` | dataflow | **convention D8**: subgraph → stage; flow label = edge label or `to <targetLabel>` |
| `sequenceDiagram` | `sequence` (auto) | sequence | vendored: participants / messages / notes / rect |
| `stateDiagram`(-v2) | `lifecycle` (auto) | lifecycle | vendored: states / transitions / `[*]` |

Auto-detection: first token (`sequenceDiagram` | `stateDiagram*` | `flowchart|graph`).
`--type` selects among flowchart's three targets (default `workflow`, the doc's primary
mapping; `architecture`/`dataflow` are the explicit choices for the judgment cases —
"component map" / D8). Passing `--type` for an auto-dialect is a usage error (the
dialect already decides).

**Syntax bound (v1)** — supported:
- flowchart: `direction` (TB/TD/LR/BT), node `id["label"]` + shapes `[]`/`()`/`{}`/`[()]`
  + inline `id:::class`; links `-->` / `-.->` / `==>` (→ `variant: emphasis`), `-- text -->`,
  `-->|text|`; `subgraph` (title `id["label"]`, body) — 1 level deep; `classDef` / `style` /
  `class` consumed for semantic typing (§7.1.4), otherwise dropped (the doc says drop styling).
- sequence: `participant [alias] [as Label]`, messages `->>` / `-->>` (→ `variant: return`),
  `Note [right|left|over] A[,B]: text`, `rect` blocks (→ `segments`), `activate`/`deactivate`
  (→ `activations`).
- state: `state "Label" as X`, `[*]` (→ `type: start` / `terminal` lane), `A --> B: label`.
- **Unrecognized or recognized-but-unbounded syntax → hard error with file/line** — never a
  silent drop (a half-converted IR is valid-but-wrong, the worst copy-adapt outcome).
  Documented unbounded list (also in `--help`): `linkStyle` (dropped — style only), `classDef`
  names not matching the semantic table (dropped — style only), sequence `alt/loop/opt/par/break`
  (error), state composites (`state X {`) / forks / joins (error), nested subgraphs >1 level
  (error), flowchart `&&` node links (error), sequence `-)`/`--)`/`--x` variants (error).

#### 7.1.2 Parser approach

Hand-written line-based subset parser (decided vs mermaid-11 AST-walk — brittle internals,
heavy import — and mmdc shell-out). Zero new deps, line-numbered errors, deterministic.

#### 7.1.3 Deterministic placement rules (minimal coordinates; renderer defaults do the rest)

- workflow: subgraphs → `lanes` (declaration order); node `col` = longest-path depth mapped
  through the well-spaced `[0,1,3,5]` column subset of the vendored grid (`colXs 88/220/300/
  430/500/625`, 92px nodes — adjacent 1↔2 and 3↔4 columns overlap; the skipped middle
  columns are routing channels). Direction (TB/TD/LR/BT) is accepted and normalized to LR:
  per the vendored doc the layering judgment belongs to the copy-adapt step (D7), so the
  converter owns only the mechanical topology; the direction of the drawing is that
  judgment. `mainPath` = walk from the entry (no non-back incoming edge) along first-out
  edges to the sink (branches stay out, like change-approval); diamond `{}` → `type: security`
  + `tag: "decision"` (only schema-supported decision semantic); `-.->` → `variant: dashed`;
  link text → edge `label` (sparingly, as the doc says). Routing trims (2nd+ fan-out edge
  adjacent→`drop` / deeper→`bottom-channel` when the run clears the legend band, back edges
  →`return-left`) plus convert-time bound errors for shapes the vendor auto-router cannot
  clear (same-lane skip edges, cross-lane same-column intermediates, shared-row loops) —
  derived from the vendored renderer's own geometry constants.
- architecture: components from nodes; subgraphs → `boundaries` (`kind: region`, `wraps`);
  **no `pos`/`size`** — grid layout default places.
- dataflow: subgraphs → `stages` (declaration order); node `stage` = subgraph index, `row` =
  appearance order; `flows` with edge label or default `to <targetLabel>` (schema requires
  flow labels).
- sequence: participants in declaration order; message `y` = 160 + 40·index (schema floor
  160); `-->>` → `variant: return`; Note → nearest message's `note`; `rect` → `segments` y
  range.
- lifecycle: reserved `main` lane (+ `terminal` when `[*]` end used); state `type` from name
  keyword table (§7.1.4), `[*]` → `start`; `col` = appearance order within lane.

#### 7.1.4 Semantic typing table (fixed, documented; shared by all modes)

Keyword scan over `classDef` class names, node labels, participant/state names →
`componentType` / lifecycle type: `db|store|cache`→database · `api|svc|service`→backend ·
`ui|web|front`→frontend · `auth|sec|fw`→security · `queue|bus|broker`→messagebus ·
`user|client|ext`→external, else → `backend` (workflow/architecture/dataflow) or `active` /
`neutral` (lifecycle, matching state names start/active/waiting/success/failure).

#### 7.1.5 CLI shape — convert + validate in one call

```
bun run mermaid:convert <input.mmd> [--type workflow|architecture|dataflow] [--out <ir.json>] [--no-validate]
```

- `scripts/mermaid-convert.ts` (scripts/deck.ts pattern; package.json script
  `mermaid:convert`; scripts-dir-contract allowlist entry).
- IR → stdout (pretty JSON, no `meta.output`) or `--out` (writes file, sets `meta.output`).
- After conversion, always run the vendored `validate` via `src/run.ts runArchify` (real
  render+composition gate). Exit `0` = converted + VALID; `1` = conversion/validation
  failure with diagnostics; `2` = usage error. `--no-validate` exits on conversion only
  (dev escape).

#### 7.1.6 "Valid IR out" contract

Every conversion in the fixture corpus must exit the vendored `validate` green. Corruption
of layout is not the product; invalid output IS a bug. Corpus: ≥2 fixtures per
dialect×mode (≥8 total) under `tests/fixtures/mermaid/`, pinned by
`tests/mermaid-convert.test.ts`: structural assertions (topology preserved: ids/labels/
edges) + `validate()` green + unsupported-syntax error cases (≥1 per dialect).

#### 7.1.7 Files, docs, non-goals

- New: `src/mermaid-convert.ts` (pure parser + 5 mappers), `scripts/mermaid-convert.ts`
  (CLI), `tests/mermaid-convert.test.ts`, `tests/fixtures/mermaid/*.mmd` + expected.
- Docs: `skills/archify/SKILL.md` authoring-loop line + README pointer. `vendored/SKILL.md`
  untouched (upstream).
- Non-goals: no new extension tool (D9), no schema/emitter/renderer changes, no IR-library
  or flagship-deck changes, dataflow convention documented as ours (D8) until upstream maps it.

### 7.2 Phase 3 — `ir` slot in layout templates (design v1, 2026-08-24)

#### 7.2.0 The insight (measured 2026-08-24, prototype-proven)

The `diagram` BlockContent kind **already exists in the template language**: `KNOWN_KINDS`
includes it, `from: "{slide.ir}"` is a valid binding, `deck-build.ts:442-449` absolutizes
`slide.ir` against `manifestDir` BEFORE template render, `resolveDiagrams` (`:291-345`)
delivers it and builds both emitters' keyed maps, and both emitters already render
template blocks. No shipped template used it — the `ir` slot is NOT a new primitive; it is
an **untested first-class seam**. Proof: a scratch `decision` template binding
`{kind:"diagram", from:"{slide.ir}", fit:"content"}` inside a `[6,2,2]` stack built
end-to-end with **zero src changes** — 1 slide, 100 native shapes, 0 `<a:blip>`, OOXML
lint clean.

#### 7.2.1 New rich templates (data only)

Three shipped templates in `templates/*.layout.json` (all binding the slide's `ir`).

Stack semantics in the template compiler: `dir "row"` splits the box VERTICALLY
(rows), `dir "col"` splits HORIZONTALLY (columns) — the prototype's first draft had
them inverted; the goldens are the authority.

- **`decision`** — "show the evidence, then make the call": content-well `stack row
  [6,2,2] gap 0.3` → `diagram {from:"{slide.ir}"}` on top, `decisionCall`
  (20pt bold title, centered) + `decisionWhy` (13pt muted) under. Slots: `call` (text,
  required), `why` (text, required).
- **`timeline-with-diagram`** — the library's timeline↔IR pair on one slide: `col [5,4]
  gap 0.4` → left = the timeline repeat (`milestones` array, `date/label/note?`, min 3
  max 6, milestone roles); right = `diagram`. Slots: `milestones` (array).
- **`figure`** — the generic exhibit: `stack row [1,6,1] gap 0.25` → `figureCaption`
  (16pt bold), `diagram`, `figureNote` (11pt muted) — the deck-lint is
  `missing-source`-friendly (a note/source line is one field away).

Template diagram blocks use the canvas fit (the `fit:"content"` option is a code-layout
affordance — template ContentSpecs do not declare it; a template `fit` key is ignored by
the compiler, so no template emits it).

#### 7.2.2 Validation — `requiresIr` (renderless)

`loadTemplate` sets `requiresIr: true` when any body node's content binds
`from === "{slide.ir}"` on a `diagram` kind. `slotProblems` (`src/deck-lint-tool.ts`)
checks it: an ir-slot template slide without `ir` → problem naming the template —
instead of the build-time "IR not found at ''" (loud but late). No build-time behavior
change (the exists-check in `resolveDiagrams` stays as backstop).

#### 7.2.3 D3-lock proof (the phase's real risk item)

By construction nothing frozen changes (the seam is already wired); the proof is a test
bus, not an argument: (a) the legacy D3/D5 suites pass UNCHANGED (`layouts.test.ts`
chrome goldens, `deck-composition.test.ts` byte-proxy pins, shape-IR goldens); (b) one
new it in `deck-composition.test.ts` for an ir-slot slide: 0 `<a:blip>`, shape/text
counts, `fit=content` in the `formatBlocks` golden, OOXML lint clean; (c) a per-primitive
template-diagram golden in `layout-template.test.ts`.

#### 7.2.4 Tests + docs

- `tests/shipped-templates.test.ts`: SHIPPED 7→10, one PAYLOADS entry per template +
  regenerated `tests/fixtures/templates/{decision,timeline-with-diagram,figure}.txt`.
- `deck-lint-tool.test.ts`: `requiresIr` case (missing ir names the template).
- Demo slides: `examples/deck-general/deck.config.json` gains 3 slides; the pinned layout
  order in `tests/deck-composition.test.ts:250-264` updated deliberately.
- Docs: `skills/archify/authoring-templates.md` (the `ir` binding + `requiresIr`), README
  template list, SKILL.md pointer.

#### 7.2.5 Non-goals

- No change to the `diagram` code layout, `CONTENT`/`TITLE_BAND`, chrome emitter options,
  canvas-fit default, or any frozen constant; no new BlockContent kind (Q4 rationale: the
  `diagram` kind IS the primitive; a duplicate `ir` kind would fork both emitters).
- No `fit` option beyond `"content"` (v1).
- No changes to existing examples beyond the deliberate deck-general demo slides (D5
  = zero behavior change to existing decks/slides; deck-general gains slides, it does not
  change).

### 7.3 Phase 4 (queue)

- **Phase 4**: re-run `archify-deck-visual-fidelity`'s measured checks (title band wrap,
  takeaway placement) against the library deck and the benchmark `aspice4-chip-v5`; fix
  and fold back as gates.
