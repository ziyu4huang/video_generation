# 06 — Verdict + port-design: retrieval improvements

type: grilling
blocked by: 01 — Ranking criteria for the improvement spec, 02 — Remnic retrieval stack: deep-dive + portability
claimed: wayfind (claude, 2026-07-29, session 2)

## Question

Given the **ranking criteria** (01) and the **retrieval deep-dive** (02): for
each retrieval mechanism Remnic does better — hybrid BM25+vector, reranking,
graph recall, memory-worth scoring, per-result provenance — decide:

- **IN** — goes into the spec, with a Pi-native port-design sketch (storage
  substrate, embedding source, reranker approach) sharp enough to hand to
  writing-plans.
- **DEFERRED** — promising but blocked on graduating fog (embedding source /
  substrate / token-cost); named as a follow-up.
- **OUT** — not worth it for hermes; one-line why.

This is a grilling ticket — resolve with the human one mechanism at a time,
ranking each against (01). The collection of IN port-designs is the retrieval
section of the final spec (09).

## Recommended starting point (to be confirmed against 01 + 02)

Likely IN: a vector layer on the existing SQLite spine (hybrid FTS5 + vector),
with provenance stamped on results. Likely DEFERRED: graph recall and
model-based reranking (cost/substrate fog). Likely OUT: anything requiring a
CUDA embedding server. Adjust once 02 lands.

## Resolution

_Closed (grilling) — 2026-07-29, session 2. Accepted the recommended verdict. Reconciled with origin/main parallel effort `2026-07-29-persistent-to-planning` T01/T02 (single DB + `project` field + MD source-of-truth). Becomes the retrieval section of the spec (09)._

### Verdict (per 01 ranking model: gain × Pi-fit score; effort/token gates; strength tiebreak)

| # | Mechanism | Verdict | Port-design sketch |
|---|---|---|---|
| 1 | **Memory-worth scoring** | **IN** | Frontmatter `mw_success`/`mw_fail` (default 0/0); query-time multiplier `score *= p_success/0.5` where `p_success = (s+1)/(s+f+2)` (Laplace), uninstrumented→neutral 1.0, optional exp recency decay. Counters are a **read-side need → DB column** (extend the memory row in the single DB; MD frontmatter stays source of truth, `sync-markdown-memories` mirrors). Trigger: increment on session outcome (reuse hermes failure-detection signal). Effort **S**. |
| 2 | **Provenance** | **IN** | Frontmatter `sources[]` (`{kind, locator, capture}`) + `provenance` enum (`verified`/`unverified`/`none`); write-path attaches source quote/locator at write time. **Frontmatter only — no DB column** (not read at query time; per parallel T02's "no col w/o read need"). `verified` requires a surviving source. Pairs with 07's `evidence[]`. Effort **S**. |
| 3 | **LLM-judge reranker** | **IN** | Post-FTS step in `memory_search`: take top-K (~20) FTS hits, one `spawnSubagent`/host-LLM call with a JSON 0–100 scoring prompt, sort, return top-N; TTL cache keyed by (query, candidate-set hash); noop fallback. Config `memoryRerank: "off"|"llm"` (opt-in), `rerankMaxCandidates`. Token bounded by cache+cap (respects 08 gate). Effort **M**. |
| 4 | **Boost multipliers + degradation-aware search** | **IN** | Recency/access/importance multipliers (pure, post-query) + `reportSearchDegradation` observability (tier served-by, score decomposition) — the hermes slice of Remnic's recall X-ray. Effort **S–M**. |
| 5 | **Graph recall** (in-memory PPR) | **DEFER (phase-2)** | Build adjacency in-memory from the top-K candidates via an **edge extractor** (links on shared entities/tags), run Personalized PageRank seeded by top hits. Defer: edge extractor is M–L effort and rides the sync path **parallel T04** is building. Revisit after #1–4 land + eval (05) shows recall gaps transitive recall closes. |
| 6 | **Vector / hybrid layer** | **DEFER (phase-2, eval-gated)** | `sqlite-vec` `vec0` virtual table in the **existing single DB** beside FTS5; embeddings at index time via `sync-markdown-memories` (**dependency: parallel T04** second-source scan). Embeddings: MLX-local preferred (host-injected seam, `--offline`, bfloat16) — exact model = remaining fog; API (`text-embedding-3-small`) opt-in. Query = hybrid FTS5+vector then #3 reranker. Injection stays **policy-only → no token inflation**. Gated on (a) eval showing the gap, (b) settled MLX model. **Headline phase-2 follow-up, not a rejection.** |
| — | QMD binary / LanceDB / Meilisearch / Orama / SurrealDB-for-graph | **OUT** | GPU native binary / Arrow bindings / server process / duplicates FTS5 / PPR needs no graph store. |

**Ranking (per 01):** IN order = worth > provenance > rerank > boost (all pass effort/token gates; ranked by gain×fit). Graph + vector **deferred** on the effort gate (L) + evidence — they carry port-design sketches and return as phase-2.

**Compatibility:** all six are consistent with the single-DB + `project` field + MD-source-of-truth model (parallel T01/T02). The only read-side-justified DB-column addition is the worth counters; provenance stays frontmatter. The two deferrals (graph edge-extraction, vector embedding-at-index) both touch the `sync-markdown-memories` path — flag the dependency on parallel T04 for writing-plans.
