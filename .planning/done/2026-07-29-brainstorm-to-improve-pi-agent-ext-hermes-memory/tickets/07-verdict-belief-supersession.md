# 07 — Verdict + port-design: belief/supersession (Relay-style corrections)

type: grilling
blocked by: 01 — Ranking criteria for the improvement spec, 03 — Remnic belief-ledger / Relay supersession: deep-dive + portability
claimed: wayfind (claude, 2026-07-29, session 3)

## Question

Given the **ranking criteria** (01) and the **belief-ledger deep-dive** (03):
does hermes adopt a **versioned, supersedeable, provenance-bearing belief
model** (Remnic's Relay-style correction lineage), and if so, how much?

Decide, one sub-question at a time with the human:

- **Full** — adopt the belief-ledger model wholesale (versioned beliefs,
  append-only supersession, evidence/provenance, fresh-agent verification).
- **Partial** — adopt the high-value slice (e.g. append-only supersession +
  provenance on corrections/failures) onto hermes's existing categorized memory
  + correction-detection, without a full model change.
- **OUT** — stay with hermes's flat categorized memory; one-line why.

For whatever's IN, sketch the port-design onto hermes's MD+SQLite spine, sized
for one plan, sharp enough for writing-plans. This becomes the memory-model
section of the final spec (09).

## Recommended starting point (to be confirmed against 01 + 03)

Likely **Partial**: append-only supersession + provenance on the
`failure` / `correction` categories (the memories most likely to go stale and
most harmful when wrong), reusing hermes's existing correction-detection as the
trigger. Fresh-agent verification likely OUT (demo/product concern, heavy).
Adjust once 03 lands.

## Resolution

_Closed (grilling) — 2026-07-29, session 3. Accepted **Partial**. Becomes the memory-model section of the spec (09). Reconciled with 06 (provenance `sources[]` already IN → 07 reuses it for evidence, no separate field) and the single-DB+project-field model (parallel T02)._

### Verdict (per 01 ranking model: gain × Pi-fit score; effort/token gates; strength tiebreak)

| Slice | Verdict | Port-design sketch |
|---|---|---|
| **Versioned append-only supersession** | **IN** | Frontmatter: `status` (active\|superseded, default active), `supersedes` (id), `supersededBy` (id), `parentIds[]` (ids). SQLite mirror: matching columns (these ARE read-side needs — `memory_search` filters `status`; lineage traversal needs the link ids). `memory_search` **defaults to `status='active'`**, with an override flag to surface superseded for inspection. "Current truth" derived by walking the chain, never a stored flag. Effort **M**. |
| **`memory_supersede` tool** | **IN** | `memory_supersede(priorId, replacement, reason, evidence[])`: writes a new `correction`-category entry with `supersedes=priorId` + `parentIds=[priorId]`; flips prior frontmatter `status=superseded` + `supersededBy=newId` (**file preserved** — append-only, old entry visible via override); appends a sealed audit line (`lineage: [priorId, newId]`). Evidence attaches via the **same `sources[]` field 06 IN'd** (kind/locator/capture) — no separate `evidence[]` field; `reason` is a short string. Triggered by hermes's existing correction-detection (upgrades "write a flat correction" → "write a linked supersession"). Effort **M**. |
| **Verification probe** | **IN** | After each `memory_supersede`, run one internal `memory_search` (single-process, no daemon), assert (a) replacement id present + (b) prior id absent under the default active filter, log a `supersession_verified` audit. The portable core of Remnic's fresh-agent verification. Effort **S**. |
| **Auto-consolidation coupling** | **IN** *(necessary)* | Constrain the consolidator (char-limit trim child) to merge **within** a `status` and **preserve** `supersedes`/`supersededBy`/`parentIds` links — never collapse an active↔superseded pair's lineage. Regression test: a supersession chain survives consolidation. Effort **S–M**. |
| Full belief-ledger (Brier predictions, stance, confidence calibration, Socratic challenge) | **OUT** | Prediction-calibration isn't hermes's domain; heavy, marginal gain. |
| Cross-agent Relay (4-role runner, Mission Control, namespace store, credit/isolation, clean-room judge) | **OUT** | Platform, Linux/Codex-only. Only the portable single-process probe survives. |
| Fresh-agent verification in a *separate* clean-room agent | **OUT** | Platform; the probe above is the hermes-shaped slice. |

**Trigger scope (v1):** wire correction-detection → supersession for **`failure` + `correction`** (most harmful-when-stale). The *mechanism* is category-agnostic, so `preference`/`insight`/`tool-quirk` can supersede later with **no schema change** (just more trigger paths).

**Reconciliation:** 07's evidence **reuses 06's `sources[]`** provenance field (one frontmatter field, no duplication). 07's `status`/lineage columns are read-side-justified DB additions (like 06's worth counters), consistent with parallel T02's "no DB column w/o read need" — `status` IS read at query time.

**Ranking (per 01):** high gain (fixes hermes's worst failure mode — stale wrong memory repeatedly recalled) × excellent Pi-fit (pure MD frontmatter + SQLite columns + one tool + one probe, **no substrate**) → IN, top priority alongside 06's worth-scoring. Token-**neutral-to-positive** (the `status` filter *hides* superseded → less recall noise).
