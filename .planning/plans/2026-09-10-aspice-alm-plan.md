# ASPICE 4.0 / ALM Assessment-Report Kit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an ASPICE 4.0 assessment-report KIT built entirely from archify's data-driven surfaces — two new `*.layout.json` templates (`aspice-bp`, `pa-rating`), a working assessment example deck (`examples/aspice4-alm/`) authored through the deck pack/unpack JSONL envelope (#2241), and the manifest-schema parity entries for the new slot fields. **Zero engine / vendored / runtime-dep changes.**

**Architecture:** Everything is data. The BP-verdict table and the N/P/L/F capability strip are layout templates (region/stack/repeat/box + binding tokens — the DSL in `src/layout-template.ts`); the assessment deck is a `deck.config.json` whose evidence refs ride template slots; the ALM workflow (assessor appends/edits evidence lines → repack → rebuild) is the existing byte-stable JSONL envelope (`src/deck-pack.ts`) demonstrated end-to-end by a committed `assessment.deckl` + tests. The manifest schema (`schemas/deck-manifest.schema.json`) gains typed entries for the new slot fields, mirroring the `kpis`/`milestones` precedent.

**Tech Stack:** Bun + TypeScript (existing), JSON layout templates, JSONL envelope, `bun test` + `tsc --noEmit` gates. Reviewer: GLM-5.3 on every diff. No new dependencies (ajv stays dev-only).

---

## Global Constraints

- **No engine/vendored changes.** The vendored archify@2.12.0 bin (`vendored/bin/archify.mjs` + `vendored/schemas/*.schema.json`) is untouched. No new runtime deps; `ajv` remains devDependency-only (`src/` imports zero ajv — pinned by `tests/deck-manifest-schema.test.ts`).
- **Templates are data.** Dropping `templates/*.layout.json` into the shipped tier IS registration (`loadRegistry` scans `<pkg>/templates/`). No `.ts` file may be added to make a template work — that absence is the point of the seam.
- **ASPICE 4.0 factual boundary.** Structural claims in deck copy / README are limited to this grounded list (verified 2026-09-10 via web):
  1. ASPICE 4.0 PAM released by VDA QMC on 2023-11-29 (revision of 3.1).
  2. ~10 seldom-used processes removed; ~10 processes + 3 process groups added; ALL processes reworked with FEWER base practices (BPs) than 3.1.
  3. New groups: HWE (HWE.1 Requirements Eng, HWE.2 Detailed Design & Component Dev, HWE.3 Technical Data Package Review, HWE.4 HW Verification); MLE (MLE.1–MLE.4, machine learning engineering); SUP.11 (ML data management).
  4. Assessment ratings: PA 1.1 process accomplishment via BP satisfaction; capability levels via generic practices; N/P/L/F rating scale.
  - Everything else (BP statement paraphrases, verdict values, GP ratings, dates, counts in the readout) is **illustrative** and labeled as such on the cover slide, the closing slide, and the README.
- **Tests are string/structural, no browser.** `tests/no-browser-deps.test.ts` stays green; goldens are `formatBlocks` text files.
- **Determinism discipline.** No timestamps anywhere; the envelope is byte-stable (`stableStringify`, deep-sorted keys); `pack → unpack → pack` round-trips byte-identical.
- **Gates per ticket:** `( cd bun-apps/s2-agent-ext-archify && bun test && bun run typecheck )` green + GLM-5.3 review. One PR per ticket, squash-merge via `gh ship` (repo standing rule: local green = merge).
- **Planning artifacts committed** (this file lives in `.planning/plans/`, which is durable-shared per repo convention).

---

## Grounding: the surfaces this plan builds on (read before executing)

| Surface | What it gives us | Key traps |
| --- | --- | --- |
| `src/layout-template.ts` | The template DSL: `slots` (text/array, `of`/min/max/required), `roles` (Palette-key colors only), `chrome`, body = `region`/`stack`/`repeat`/`box`, binding tokens `{field}` `{slide.<key>}` `{index0}` `{index1}` | **INVERSION**: `stack.dir:"row"` = rows stacked VERTICALLY; `dir:"col"` = columns side by side. `repeat.flow:"row"` = tiles side by side; `flow:"col"` = cells stacked vertically. **No conditional roles** — a role's color/size is static per template, so per-value verdict coloring is impossible without engine change. |
| `templates/*.layout.json` + `templates/layout-template.schema.json` | 10 shipped templates; `kpi-row` (repeat tiles) and `table` (native table primitive) are the geometry precedents | Template `name` must not shadow the six code layouts; roles need `sizePt`+`color` if not builtin |
| `src/layout-registry.ts` + `slotProblems` | Tier scan (`$ARCHIFY_TEMPLATES` → `<manifestDir>/templates/` → `<pkg>/templates/`); missing/over-full slots REFUSE the build | Catalog order = filename sort within the shipped tier |
| `src/deck-pack.ts` + `scripts/deck.ts pack/unpack` | JSONL envelope v1: header line (manifest minus slides + `format`/`version`/`slideCount`) + one line per slide; `unpackDeck` validates format, version, and `slideCount` vs actual lines | Appending a slide line requires bumping header `slideCount` or unpack refuses |
| `src/deck-combine.ts` | `--combine` → single-file `deck.html` with presenter-notes pane; deterministic | — |
| `schemas/deck-manifest.schema.json` + `tests/deck-manifest-schema.test.ts` | Parity contract (prior effort D2): schema = declarative twin, `parseManifest` = runtime authority; template slot fields get typed entries (`kpis`, `milestones`, `call`, `why`… precedent) | **No enums for semantic values** — schema stricter than runtime breaks the dual-gate agreement; semantics live in slot `description`s |
| `examples/vmodel/`, `examples/decks/as5200-pcie/`, `examples/ir-library/` | Precedents: ASPICE-themed example deck with `views:"expand"`; example-folder README + regenerate commands; flagship deck + catalog | Generated artifacts go to repo-root `output/` (gitignored), never committed |
| Prior effort `.planning/2026-09-08-archify-deck-html/map.md` | D1 (font embedding rejected), D2 (schema = parity contract), D3 (`manifestVersion` naming), t03 = pack/unpack shipped as #2241 | Do NOT re-decide these |

**Pinned-count blast radius when `templates/` gains files** (each must be updated in the SAME ticket as the template lands, or the suite goes red):
- `tests/shipped-templates.test.ts` — `SHIPPED` array, `toHaveLength(10)`, new `PAYLOADS` + goldens
- `tests/deck-lint-tool.test.ts:124` — pinned catalog name array (filename sort)
- `tests/deck-skeletons.test.ts:19` + `tests/ir-library.test.ts:33` — local `SHIPPED_TEMPLATES` consts (the seven general-purpose rich templates)
- `tests/deck-composition.test.ts:243` — deck-general describe label says "all ten" (wording only; deck-general itself stays 10 slides)

---

## File Structure (what exists → what this effort adds)

```
bun-apps/s2-agent-ext-archify/
  templates/
    aspice-bp.layout.json        # CREATE (t-A) — BP rows w/ verdict chips + evidence refs
    pa-rating.layout.json        # CREATE (t-A) — capability strip N/P/L/F per GP
  schemas/
    deck-manifest.schema.json    # MODIFY (t-C) — typed entries: process/bps/attribute/ratings
  examples/aspice4-alm/          # CREATE (t-B) — the assessment KIT
    README.md                    #   ALM workflow doc + grounded-facts vs illustrative split
    deck.config.json             #   12-slide assessment deck (committed source)
    assessment.deckl             #   packed JSONL envelope (committed ALM artifact)
    trace/
      req-test-chain.architecture.json   # copy-adapt of ir-library req-chain archetype
      mle-data.workflow.json             # copy-adapt workflow archetype (SUP.11/MLE flow)
  tests/
    shipped-templates.test.ts    # MODIFY (t-A)
    deck-lint-tool.test.ts       # MODIFY (t-A)
    deck-slot-gate.test.ts       # MODIFY (t-A) — aspice negatives
    deck-skeletons.test.ts       # MODIFY (t-A) — const rename/retitle
    ir-library.test.ts           # MODIFY (t-A) — const rename/retitle
    deck-manifest-schema.test.ts # MODIFY (t-C)
    aspice4-alm.test.ts          # CREATE (t-B) — build + envelope workflows + union coverage
```

---

## Task t-D (FIRST, evaluative): Confirm "no `aspice` IR type / no engine change" with extension-point evidence

**Size:** S · **Risk:** low · **Dependency:** none (parallel-safe with t-A)

**Files:**
- Read only: `src/validate.ts`, `src/run.ts` (`VENDORED_BIN` resolution), `vendored/schemas/` (the five type schemas), `src/load-ir.ts`, `src/layout-registry.ts`
- Modify: this plan's "Give-up calls" section stays the record; additionally append the decision to `.planning/2026-09-08-archify-deck-html/map.md` is NOT wanted (that effort is closed) — record it as **Decision D-aspice-1 in the PR description of t-A** and in `examples/aspice4-alm/README.md` (t-B) as the design-rationale paragraph.

**Expected verdict: NO engine change.** Verify by reading:

- [ ] `src/validate.ts:12` — the `type` param enumerates `architecture|workflow|sequence|dataflow|lifecycle` and forwards to the vendored bin; `diagram_type` is validated by `vendored/schemas/*.schema.json` (upstream-owned). An `aspice` type = new vendored schema + vendored renderer + golden-snapshot regen = exactly the upstream churn the iteration directive forbids.
- [ ] The data-driven path covers every artifact need: BP table / PA strip → layout templates (t-A); traceability chain / ML-data flow → existing `architecture` + `workflow` IRs (t-B); evidence records → JSONL envelope lines (t-B).
- [ ] Confirm zero `.ts` files under `src/` or `vendored/` change in t-A/t-B diffs (the reviewer checks this explicitly).

**Acceptance:** PR description (t-A) carries D-aspice-1 with file:line evidence; no code delta attributable to t-D.

---

## Task t-A: Ship `aspice-bp` + `pa-rating` layout templates (data only)

**Size:** M · **Risk:** medium (geometry + golden calibration; title-extent refusal on long action titles) · **Depends:** t-D verdict recorded (expected NO)

**Files:**
- Create: `templates/aspice-bp.layout.json`, `templates/pa-rating.layout.json`
- Create: `tests/fixtures/templates/aspice-bp.txt`, `tests/fixtures/templates/pa-rating.txt` (goldens, via `UPDATE_TEMPLATE_GOLDENS=1`)
- Modify: `tests/shipped-templates.test.ts`, `tests/deck-lint-tool.test.ts`, `tests/deck-slot-gate.test.ts`, `tests/deck-skeletons.test.ts`, `tests/ir-library.test.ts`, `tests/deck-composition.test.ts` (describe-label wording only), `README.md` (template-count mentions + one vertical sentence)

**Interfaces (what t-B/t-C rely on — exact slot names):**

`aspice-bp` slots:
```jsonc
{
  "process":  { "kind": "text", "required": true,
                "description": "the process identity band, e.g. \"SWE.1 · Software Requirements Analysis · ASPICE 4.0\"" },
  "bps":      { "kind": "array", "of": ["id", "practice", "verdict", "evidence?"],
                "min": 2, "max": 8, "required": true,
                "description": "one row per base practice; `id` e.g. BP1, `practice` the paraphrased BP statement, `verdict` SAT / PART / MISS, `evidence` the traceable work-product ref (JSONL line, artifact id)" }
}
```

`pa-rating` slots:
```jsonc
{
  "attribute": { "kind": "text", "required": true,
                 "description": "the process attribute being rated, e.g. \"PA 1.1 · Process Performance — SWE.1\"" },
  "ratings":   { "kind": "array", "of": ["gp", "rating"], "min": 2, "max": 6, "required": true,
                 "description": "one tile per generic practice; `gp` is the GP id (e.g. GP 1.1.1), `rating` is N / P / L / F. The capability conclusion goes in the slide `takeaway` (the chrome band already renders it)." }
}
```

Body sketches (dir/flow values chosen deliberately — mind the INVERSION table):

`aspice-bp` body — process band on top, BP rows stacked under it:
```jsonc
"body": [
  { "region": "content",
    "stack": { "dir": "row", "weights": [1, 9], "gap": 0.18 },   // row = vertical stack of two bands
    "children": [
      { "box": "fill",
        "content": { "kind": "text", "role": "aspiceProcess", "from": "{slide.process}" },
        "valign": "middle" },
      { "repeat": { "over": "bps", "flow": "col", "gap": 0.14, "max": 8 },  // col = rows stack downward
        "cell": [
          { "stack": { "dir": "col", "weights": [1, 5, 1.3, 2.4], "gap": 0.12 },  // col = 4 side-by-side columns
            "children": [
              { "box": { "inset": [0.08, 0.04, 0.08, 0.04] },
                "content": { "kind": "text", "role": "bpId", "from": "{id}" }, "valign": "middle" },
              { "box": "fill",
                "content": { "kind": "text", "role": "bpPractice", "from": "{practice}" }, "valign": "middle" },
              { "box": "fill",
                "content": { "kind": "text", "role": "bpVerdict", "from": "{verdict}" },
                "align": "center", "valign": "middle" },
              { "box": "fill",
                "content": { "kind": "text", "role": "bpEvidence", "from": "{evidence}" }, "valign": "middle" }
            ] }
        ] }
    ] }
]
```

`pa-rating` body — attribute band, then a horizontal tile strip:
```jsonc
"body": [
  { "region": "content",
    "stack": { "dir": "row", "weights": [1, 7], "gap": 0.2 },
    "children": [
      { "box": "fill",
        "content": { "kind": "text", "role": "paAttribute", "from": "{slide.attribute}" }, "valign": "middle" },
      { "repeat": { "over": "ratings", "flow": "row", "gap": 0.25 },   // row = tiles side by side
        "cell": [
          { "stack": { "dir": "row", "weights": [5, 4], "gap": 0.06 },
            "children": [
              { "box": "fill",
                "content": { "kind": "text", "role": "paGp", "from": "{gp}" },
                "align": "center", "valign": "bottom" },
              { "box": "fill",
                "content": { "kind": "text", "role": "paRating", "from": "{rating}" },
                "align": "center", "valign": "top" }
            ] }
        ] }
    ] }
]
```

Roles (Palette keys only — no literals; `bpPractice` carries `"autofit": true` so long paraphrases shrink instead of overflowing):
```jsonc
"aspice-bp":  { "aspiceProcess": { "sizePt": 16, "bold": true, "color": "title" },
                "bpId":       { "sizePt": 12, "bold": true, "color": "muted" },
                "bpPractice": { "sizePt": 13, "color": "body", "autofit": true },
                "bpVerdict":  { "sizePt": 13, "bold": true, "color": "accent" },
                "bpEvidence": { "sizePt": 11, "color": "muted" } }
"pa-rating":  { "paAttribute": { "sizePt": 16, "bold": true, "color": "title" },
                "paGp":       { "sizePt": 12, "color": "muted" },
                "paRating":   { "sizePt": 28, "bold": true, "color": "accent" } }
```

Both carry `"chrome": true` (action title + takeaway band + footer `source`); descriptions must carry their discriminating load (catalog rule: >20 chars, says when to use — mention each other so the agent can tell them apart).

**Steps:**

- [ ] Author both `*.layout.json` exactly as sketched; calibrate weights against a scratch slide payload (reuse the t-B values below) — adjust weights, never add expressions.
- [ ] `bun run typecheck` — templates are data; nothing to typecheck in them, but the suite must stay green.
- [ ] Update `tests/shipped-templates.test.ts`: append `"aspice-bp"`, `"pa-rating"` to `SHIPPED`; `toHaveLength(10)` → `toHaveLength(12)`; add `PAYLOADS` entries with realistic assessment copy (CJK, mirroring the existing style), e.g. for `aspice-bp`:
  ```ts
  "aspice-bp": {
    slide: {
      title: "SWE.1 八條基礎實踐中六條完全滿足，證據鏈可回溯",
      takeaway: "BP3 與 BP7 的部分滿足是本輪補強重點",
      process: "SWE.1 · 軟體需求分析 · ASPICE 4.0",
      bps: [
        { id: "BP1", practice: "識別並記錄軟體需求（示意改寫）", verdict: "SAT",  evidence: "req-baseline.jsonl:12" },
        { id: "BP2", practice: "分析介面與約束（示意改寫）",     verdict: "SAT",  evidence: "interface-matrix.jsonl:3" },
        { id: "BP3", practice: "驗證需求可測性（示意改寫）",     verdict: "PART", evidence: "verify-log.jsonl:41" },
        { id: "BP4", practice: "建立雙向追溯（示意改寫）",       verdict: "SAT",  evidence: "trace/req-test-chain.json" }
      ]
    } as unknown as Slide,
    assert: ["SWE.1", "BP3", "PART", "verify-log.jsonl:41", "req-test-chain.json"]
  },
  "pa-rating": {
    slide: {
      title: "PA 1.1 完全達成，能力等級一成立",
      takeaway: "示意評級：GP 1.1.1–1.1.4 逐項 N/P/L/F",
      attribute: "PA 1.1 · 流程績效 — SWE.1",
      ratings: [
        { gp: "GP 1.1.1", rating: "F" },
        { gp: "GP 1.1.2", rating: "F" },
        { gp: "GP 1.1.3", rating: "L" },
        { gp: "GP 1.1.4", rating: "F" }
      ]
    } as unknown as Slide,
    assert: ["PA 1.1", "GP 1.1.3", "L", "F"]
  },
  ```
- [ ] Regenerate goldens: `UPDATE_TEMPLATE_GOLDENS=1 bun test shipped-templates`, then eyeball `tests/fixtures/templates/aspice-bp.txt` / `pa-rating.txt` (column alignment, verdict column present) and re-run without the env var.
- [ ] Update `tests/deck-lint-tool.test.ts` pinned array — insert `"aspice-bp"` after `"agenda"` and `"pa-rating"` after `"kpi-row"` (filename sort: agenda < aspice-bp < compare; kpi-row < pa-rating < quote).
- [ ] Add slot-gate negatives to `tests/deck-slot-gate.test.ts` (mirror the kpi-row shape):
  - `aspice-bp` without `bps` → `DeckError` message contains ``missing slot `bps` `` and `layout "aspice-bp"`.
  - `aspice-bp` with 9 `bps` (over `max: 8`) → message contains `the layout draws at most 8`.
  - `pa-rating` without `ratings` → ``missing slot `ratings` ``.
- [ ] Rename the local consts in `tests/deck-skeletons.test.ts` + `tests/ir-library.test.ts`: `SHIPPED_TEMPLATES` → `GENERAL_RICH_TEMPLATES` (same seven names), retitle their tests to "every general-purpose rich template …" with a one-line comment pointing at `examples/aspice4-alm/` as the exerciser of the domain vertical (lands in t-B; the union-coverage test arrives there).
- [ ] `tests/deck-composition.test.ts:243` — reword the describe label to "all ten general-purpose shipped templates build as one deck" (comment-level; assertions unchanged).
- [ ] `README.md` — update the "10 rich template" mentions to twelve, and add one sentence under "Layout templates": the ASPICE 4.0 / ALM vertical (`aspice-bp`, `pa-rating`) with its worked example at `examples/aspice4-alm/`.
- [ ] Full gates: `( cd bun-apps/s2-agent-ext-archify && bun test && bun run typecheck )`; commit; PR; GLM-5.3 review; `gh ship`.

**Test list (this ticket):** `shipped-templates.test.ts` (12 load clean, catalog, goldens, CJK asserts), `deck-lint-tool.test.ts` (catalog order), `deck-slot-gate.test.ts` (3 new negatives), wording/const edits in `deck-skeletons` / `ir-library` / `deck-composition`.

**Acceptance criteria:**
1. `archify_deck_lint` (no args) lists `aspice-bp` and `pa-rating` with slots + descriptions; suite green.
2. Goldens committed and stable across two runs; verdict/evidence strings reach both emitters (golden = `formatBlocks`, the twin-property spot-check pattern).
3. Missing/overfull slots refuse the build, naming slot + layout.
4. Zero `.ts` changes under `src/` (reviewer-verified) — D-aspice-1 holds.

---

## Task t-C: Manifest-schema parity entries for the new slot fields

**Size:** S · **Risk:** low (mirrors the `kpis`/`milestones` precedent exactly) · **Depends:** t-A (final slot names)

**Files:**
- Modify: `schemas/deck-manifest.schema.json` — inside `properties.slides.items.properties` add exactly four entries:
  ```jsonc
  "process":  { "type": "string" },
  "bps":      { "type": "array",
                "items": { "type": "object", "required": ["id", "practice", "verdict"],
                           "properties": { "id": { "type": "string" },
                                           "practice": { "type": "string" },
                                           "verdict": { "type": "string" },
                                           "evidence": { "type": "string" } },
                           "additionalProperties": false } },
  "attribute": { "type": "string" },
  "ratings":  { "type": "array",
                "items": { "type": "object", "required": ["gp", "rating"],
                           "properties": { "gp": { "type": "string" },
                                           "rating": { "type": "string" } },
                           "additionalProperties": false } }
  ```
  **Deliberately NO enums** on `verdict`/`rating` (SAT/PART/MISS, N/P/L/F stay free-form strings): the parity contract's authority split (prior effort D2) keeps semantics in `slotProblems` + slot descriptions; an enum would make the schema stricter than `parseManifest` and break the dual-gate agreement. The allowed vocabularies are documented in the templates' slot `description`s (t-A) and the README (t-B).
- Modify: `tests/deck-manifest-schema.test.ts`

**Steps:**

- [ ] Add the four entries above (item shapes mirror `kpis` — `required` core fields, `additionalProperties: false`, optional tail field).
- [ ] Extend the contract test with DIRECT schema assertions (not `expectDualGate` — these are schema-strict item-shape cases, same class as the existing `kpis` items; the dual-gate matrix stays for both-reject cases):
  ```ts
  describe("deck-manifest schema — aspice slot fields (t-C)", () => {
    const OK = `{"output":"x.pptx","slides":[{"title":"t","layout":"aspice-bp",
      "process":"SWE.1","bps":[{"id":"BP1","practice":"p","verdict":"SAT","evidence":"e.jsonl:1"}]}]}`;
    test("a well-formed aspice-bp slide validates", () => {
      expect(validate(JSON.parse(OK)) as boolean).toBe(true);
    });
    test("bps item missing `verdict` is rejected by the schema (structure), accepted by parseManifest (semantics live in slotProblems)", () => {
      const raw = OK.replace('"verdict":"SAT",', "");
      expect(validate(JSON.parse(raw)) as boolean).toBe(false);
      // authority split, same direction as the kpis item shapes:
      expect(tryParse(raw).ok).toBe(true);
    });
    test("ratings item with an unknown extra key is rejected by the schema", () => {
      const raw = `{"output":"x.pptx","slides":[{"title":"t","layout":"pa-rating",
        "attribute":"PA 1.1","ratings":[{"gp":"GP 1.1.1","rating":"F","bogus":1}]}]}`;
      expect(validate(JSON.parse(raw)) as boolean).toBe(false);
    });
  });
  ```
- [ ] Run the suite; commit; PR; review; ship.

**Test list:** 3 new direct-schema cases + all existing parity/canary cases unchanged.

**Acceptance criteria:**
1. The four fields are typed in the schema with `additionalProperties: false` item shapes; no enums.
2. Existing parity matrix, authority canary, and message-text tests untouched and green.
3. `ajv` still dev-only (no `src/` import).

---

## Task t-B: `examples/aspice4-alm/` — the working assessment deck + ALM workflow

**Size:** M-L · **Risk:** medium (lint-clean action titles; envelope byte-stability; title-extent refusals on long titles — keep titles ≤ ~60 latin chars) · **Depends:** t-A + t-C

**Files:**
- Create: `examples/aspice4-alm/deck.config.json` (12 slides, committed)
- Create: `examples/aspice4-alm/assessment.deckl` (packed envelope, committed — new precedent, justified: it IS the ALM working artifact the workflow edits, and the byte-stability test pins it)
- Create: `examples/aspice4-alm/trace/req-test-chain.architecture.json` (copy-adapt `examples/ir-library/architecture/req-chain.architecture.json`; illustrative req→arch→test chain with dashed verify crossbars)
- Create: `examples/aspice4-alm/trace/mle-data.workflow.json` (copy-adapt a workflow archetype; illustrative MLE.1→MLE.4 + SUP.11 ML-data flow)
- Create: `examples/aspice4-alm/README.md`
- Create: `tests/aspice4-alm.test.ts`
- Modify: `tests/deck-manifest-schema.test.ts` (`EXAMPLE_MANIFESTS` += the new deck), `tests/deck-pack.test.ts` (`MANIFESTS` += the new deck)

**Deck shape (12 slides; every value illustrative unless it restates a grounded structural fact):**

| # | layout | content |
| --- | --- | --- |
| 1 | `title` | eyebrow `ASPICE 4.0 · ASSESSMENT READOUT · ILLUSTRATIVE DATA`; cover claims the kit, not a real project |
| 2 | `compare` | 3.1 → 4.0 structural deltas — ONLY grounded bullets: released 2023-11-29 by VDA QMC; ~10 processes removed; ~10 processes + 3 process groups added; fewer BPs per process; new HWE/MLE groups + SUP.11 |
| 3 | `kpi-row` | readout numbers (illustrative): processes assessed / BP SAT / PART / MISS counts |
| 4 | `aspice-bp` | SWE.1 BP coverage (the flagship instance; paraphrased BP statements, evidence refs like `req-baseline.jsonl:12`) |
| 5 | `aspice-bp` | SYS.2 BP coverage (second instance proves repeatability) |
| 6 | `pa-rating` | PA 1.1 strip for SWE.1 (GP 1.1.1–1.1.4, N/P/L/F) |
| 7 | `pa-rating` | PA 2.1 / 2.2 strips (CL2 view) |
| 8 | `split` | traceability chain — `trace/req-test-chain.architecture.json` + bullets (every verify arrow points at its spec; JSONL line refs) |
| 9 | `table` | HWE/MLE/SUP.11 coverage gap matrix — rows `HWE.1..4`, `MLE.1..4`, `SUP.11` (names grounded; covered/gap status illustrative) |
| 10 | `diagram` | `trace/mle-data.workflow.json` — ML data supply + management flow |
| 11 | `timeline` | plan-of-action milestones (illustrative quarters) |
| 12 | `end` | close + `contact` + the illustrative-data disclaimer as `source` |

Manifest header: `"manifestVersion": 1` (dogfoods the version story), `"tag": "archify · ASPICE 4.0 ALM assessment kit"`, `"defaults": { "font": "PingFang TC" }`, `"output": "aspice4-alm.pptx"`. Titles are action titles (lint requires it); keep each ≤ ~60 latin chars to stay inside the title-extent band.

**JSONL envelope sketch** (what `assessment.deckl` looks like; keys deeply sorted, one slide per line):
```
{"defaults":{"font":"PingFang TC"},"format":"archify-deck","manifestVersion":1,"output":"aspice4-alm.pptx","slideCount":12,"tag":"archify · ASPICE 4.0 ALM assessment kit","theme":"light"}
{"bps":[{"evidence":"req-baseline.jsonl:12","id":"BP1","practice":"識別並記錄軟體需求（示意改寫）","verdict":"SAT"},…],"kind":"slide","layout":"aspice-bp","process":"SWE.1 · …","source":"Illustrative evidence refs","takeaway":"…","title":"…"}
… (11 more slide lines)
```

**ALM workflow the README documents (and the test proves):**
1. Assessor edits evidence: unpack (`deck unpack assessment.deckl --out work/`) → edit the SWE.1 slide line's `bps[i].evidence` (or the manifest) → repack (`deck pack work/deck.config.json`) — byte-diff confined to that slide line.
2. Assessor appends a newly-assessed process: append one slide line (copy an `aspice-bp` line, new `title`/`process`/`bps`) AND bump header `slideCount` 12→13 (`unpackDeck` refuses a mismatch — that integrity check is the workflow's guardrail) → unpack → build.
3. Rebuild: `deck build` → `.pptx` + `.slides/` + `--combine` → `deck.html` for the readout meeting.

**Steps:**

- [ ] Author the two trace IRs (copy-adapt from `examples/ir-library/`; validate happens inside `buildDeck`'s `deliver`).
- [ ] Author `deck.config.json` per the table above; run `( cd bun-apps/s2-agent-ext-archify && bun scripts/deck.ts examples/aspice4-alm/deck.config.json --output output/aspice4-alm/aspice4-alm.pptx --lint --combine )` — iterate until: build succeeds, content lint 0 notes, OOXML clean. Generated artifacts land under repo-root `output/` (gitignored, as5200 convention).
- [ ] Pack: `bun scripts/deck.ts pack examples/aspice4-alm/deck.config.json --out examples/aspice4-alm/assessment.deckl`; commit the envelope.
- [ ] Write `README.md`: what-this-is (kit demo, illustrative disclaimer), the grounded-facts list (verbatim from Global Constraints), files table, regenerate commands, the 3-step ALM workflow with exact commands, and the D-aspice-1 rationale paragraph (no engine change; data-driven surfaces).
- [ ] Write `tests/aspice4-alm.test.ts` (mirror `vmodel-example` + `deck-pack` + `deck-composition` patterns):
  ```ts
  describe("examples/aspice4-alm — the ASPICE 4.0 assessment kit", () => {
    test("builds 12 slides in the expected layout order, 0 blips, ooxml clean, lint 0 notes", …);
    // expected order: title, compare, kpi-row, aspice-bp, aspice-bp, pa-rating,
    //                 pa-rating, split, table, diagram, timeline, end
    test("slide 4 pptx XML carries BP ids + verdicts + evidence refs",
      // readZipText → /ppt/slides/slide4.xml contains "BP1", "PART", "req-baseline.jsonl:12"
    );
    test("committed assessment.deckl is byte-identical to packDeck(manifest)",
      // packDeck(JSON.parse(deck.config.json)) === await Bun.file(assessment.deckl).text()
    );
    test("unpack → build succeeds from the envelope alone (IRs external, paths as authored)", …);
    test("ALM workflow: edit-one-evidence-ref → repack changes exactly one line", …);
    test("ALM workflow: append slide line + slideCount bump → unpack+build succeed; without the bump unpack refuses naming both counts", …);
    test("union coverage: every shipped template name is exercised by ≥1 committed deck or skeleton",
      // loadRegistry({env:{}}).catalog() template-tier names ⊆
      // layouts used by: the 4 skeletons, library.config.json, deck-general, aspice4-alm deck
    );
  });
  ```
- [ ] Add the deck to `EXAMPLE_MANIFESTS` (`deck-manifest-schema.test.ts`) and `MANIFESTS` (`deck-pack.test.ts`) — it now rides every existing parity/round-trip/determinism guarantee.
- [ ] Full gates; commit; PR; review; ship.

**Test list:** 7 new tests in `aspice4-alm.test.ts` + the two MANIFESTS list additions (each drags the deck into ~6 existing guarantees for free).

**Acceptance criteria:**
1. The deck builds clean end-to-end (`--lint` 0 notes, 0 `<a:blip>`, OOXML diagnostics empty) and `--combine` produces `deck.html`.
2. `assessment.deckl` is committed and byte-stable under `pack → unpack → pack`.
3. Both ALM workflow mutations (evidence edit; append + slideCount bump) are proven by tests, including the refusal when `slideCount` is not bumped.
4. Grounded facts in copy/README match the Global Constraints list verbatim-in-substance; everything else is visibly labeled illustrative (cover eyebrow, end-slide source, README split table).
5. Union-coverage test green — no shipped template ships unexercised.

---

## Sequencing + dependency graph

```
t-D (evaluative, no code) ──┐
                            ├─→ t-A (templates + goldens + pinned tests) ─→ t-C (schema parity) ─→ t-B (example deck + envelope + README)
```

- **t-D first** (or parallel with t-A): cheap, de-risks the "data-only" claim, and its verdict is quoted in t-A's PR description and t-B's README.
- **t-A before t-C**: the schema entries mirror t-A's final slot names (`process`/`bps`/`attribute`/`ratings`).
- **t-C before t-B**: the example manifest joins `EXAMPLE_MANIFESTS` and must validate against the completed schema.
- One PR per ticket, GLM-5.3 review between, `gh ship` on local green.

---

## Give-up calls (explicit)

1. **GIVE UP — per-verdict color coding (SAT green / MISS red).** The DSL's `roles` are static per template (`layout-template.ts` `compileRoles`); conditional styling needs engine changes. Verdict emphasis = dedicated bold-accent role column. Chip = visual distinction, not per-value color.
2. **GIVE UP — an `aspice` IR type or any engine/vendored change.** `diagram_type` validation + rendering are owned by the vendored archify@2.12.0 bin (`vendored/schemas/` five types; `src/validate.ts` forwards). Traceability/ML-flow diagrams compose from existing `architecture`/`workflow` IRs. Verified in t-D; recorded as D-aspice-1.
3. **GIVE UP — enum-constraining `verdict`/`rating` values in the manifest schema.** Parity authority split (prior effort D2): schema = structure, `parseManifest`/`slotProblems` = semantics. An enum makes the schema stricter than runtime and breaks the dual-gate agreement. Vocabularies live in slot descriptions + README.
4. **GIVE UP (this iteration) — a dedicated per-evidence JSONL record format** (evidence-log schema + tooling). A new format surface is scope creep; the deck envelope's line-per-slide already models append-per-record at the assessment grain. Fog-of-war follow-up if a real assessor workflow needs sub-slide evidence lines.

---

## Open questions (≤3, with recommended defaults)

1. **BP row geometry: repeat+text columns vs the native `table` primitive.** Recommended default: **repeat+text columns** (per-column role control; verdict column reads as a chip; `autofit` on practice text). Revisit only if golden review shows a cramped evidence column — the `table` fallback is a drop-in body swap, slots unchanged.
2. **Commit the packed `assessment.deckl` in-tree?** Recommended default: **yes** — it is the ALM working artifact the workflow edits, and the byte-stability test pins it against drift. The alternative (generate on demand) weakens the demo and the append-workflow test.
3. **Register the two trace IRs into `examples/ir-library/library.catalog.json`?** Recommended default: **no** — the catalog is generic archetypes; the vertical stays self-contained under `examples/aspice4-alm/` with its own README. Revisit if the IRs prove reusable outside ASPICE.

---

## Self-review

- **Spec coverage:** operator asked for t-A (two templates) → Task t-A; t-B (example deck + JSONL authoring + README workflow) → Task t-B; t-C (schema additions + contract tests, exact entries) → Task t-C; t-D (evaluative, expected NO, extension-point verification) → Task t-D; give-up discipline → 4 explicit calls; ≤3 open questions with defaults → 3; zh-TW prose / English identifiers → this document.
- **Placeholder scan:** all slot sketches, body JSON, role tables, schema entries, test snippets, and commands are concrete; no TBD/TODO. Weights (e.g. `[1, 5, 1.3, 2.4]`) are calibration starting points — the step that calibrates them against real payloads is explicit, which is the honest granularity for data-authored geometry.
- **Type consistency:** slot names `process`/`bps` (`id`,`practice`,`verdict`,`evidence?`) and `attribute`/`ratings` (`gp`,`rating`) are identical across t-A templates, t-C schema entries, t-B deck JSON and tests. Header field `slideCount`, envelope `version`, manifest `manifestVersion` follow D3 (no collision).
