# 07 — hierarchical retrieval with score propagation

type: build (grilling closed + built 2026-08-23; map D19–D22)
status: CLOSED 2026-08-23 — index `src/surreal-index.ts` + retrieval `src/hierarchical-retrieval.ts` + seam fix (D22) + live contract tests + D14 A/B (hier 15/20 vs baseline 17/20, no default switch)
blocked by: 02 (schema), 03 (capability probe)

## Question

OpenViking's retrieval differentiator vs plain vector search: global vector search to find starting directories, then a priority-queue **directory recursion with score propagation** (3-round convergence), optionally reranked. Port this to SurrealDB + kcard:

- The recursion maps to graph traversal over record links (ticket 02's `parent` edges) — breadth/priority strategy, score propagation formula, convergence rounds at ≤4 layers / 326 agg nodes.
- **Deterministic per D5/D6 — the central fork inside this ticket**: OpenViking's `search()` runs an LLM IntentAnalyzer producing typed queries; our standing decision forbids that in v1. Options: (a) caller passes type/tier filters explicitly (like `knowledge_query` today), (b) deterministic multi-query expansion (lexical + semantic + entity-match — the existing blend, α=0.18), (c) revisit D5/D6. Default posture: (b) with (a) as the typed filter; only escalate to (c) if the eval gate (ticket 09) shows a real gap.
- Cheap path: `find()` = single-query vector/lexical search without recursion — is that just today's `knowledge_query`, or a new cheaper op on the FS surface (ticket 05)?
- Blend with existing signals: semantic blend α=0.18, hotness (ticket 08, ≤±10% per D8), IDF/count baselines — define the ranking composition and its knobs.

## Resolution (2026-08-23, grilling → build same session; map D19–D22)

Facts measured this session: agg tree is md-canonical (`agg-L<l>-<i>.md`, frontmatter `id/parent/entities/layer/clusterSize/summary`, `kind: derived-aggregation` — `aggregation-write.ts`), so the index builder derives the whole hierarchy from files alone; `getCardEmbeddings` (semantic.ts:87) resolves embed config ONCE at module load and captures baseUrl only — the model half of seam/env resolution never reaches it (cost 4 debug rounds during the D14 A/B, memory `semantic-embed-model-env-override-trap`); kcard has ZERO SurrealDB code today (ticket 02 shipped decisions only), so 07 builds the index too.

- **D19 — deterministic fork = posture (b)+(a)**: the hierarchical path embeds the caller's query (existing α=0.18 blend posture for the lexical lane stays untouched) and takes `type` as a caller-passed filter (D18); NO LLM intent analyzer. Escalation to (c) only if ticket 09's gate shows a measured gap.
- **D20 — recursion = client-side priority-queue BFS with max-propagation**: global KNN over the ONE `card` table seeds scores on leaves AND agg nodes (KNN `<|k,ef|>` returns full rows, one hop); expand downward via the reverse of the `parent` record link (plain `WHERE parent = $id` index, per-level ~40–50 ms per ticket 03); child score = max(child's own seed score, γ · parent score), γ=0.5 default; ties broken by record id sort (deterministic). "3-round convergence" maps to a bounded expansion loop (≤3 sweeps or until no score changes, tree is ≤4 layers) — with a ≤4-layer tree a single downward sweep is already convergent, the loop is the cycle-guard.
- **D21 — index build lives in kcard `src/surreal-index.ts`, D13-shaped**: fingerprint = per-card content hash over ALL folder .md; build into `card_shadow` in db `context_db` (per-user ns, D6); only after every batch lands does the builder recreate `card` (+ FTS/HNSW/plain indexes) and insert from the same in-memory rows — a failed build leaves the live table intact. Vectors come from `getCardEmbeddings`' model-keyed JSON cache (unchanged cards embed zero times). `relation`/`usage` tables (D11/D12) are defined but not populated — their writers are tickets 06/08.
- **D22 — the getCardEmbeddings seam trap closes here**: `semantic.ts` drops the module-load-time config capture; `defaultEmbedder`/`lmStudioAvailable`/`getCardEmbeddings`/`embedQuery` resolve seam → env → defaults per call (lazy), and the default model comes from that resolution instead of the bare `SEMANTIC_MODEL_DEFAULT` constant — `SEMANTIC_EMBED_MODEL` and the `__piEmbeddingConfig` seam both now reach the cards side. Fixes both the env trap AND seam-publish timing (module load can precede host publish).
- **Cheap-path answer**: flat single-query search IS today's `retrieveRecords`/`knowledge_query` — unchanged, and it stays the DEFAULT (no default switch without ticket 09's gate). Reshaping it into an FS-surface op is ticket 05's call.
- **Ranking composition**: hierarchical score = seed cosine (KNN) with propagated max; hotness has a score hook but zero effect until ticket 08 (≤±10%, D8). Knobs: `gamma` (0.5), `seedTopN` (24), `topK`.

### Build amendments (measured against live surrealdb-3.2.3, same session)

- **D9a — FULLTEXT indexes are single-column in v3.2.3**: `DEFINE INDEX … FIELDS title, summary FULLTEXT` is a parse error ("Expected one column, found 2"). Shipped as two indexes (`card_fts_title`, `card_fts_summary`); queries still OR the two lanes.
- **D9b — record key = sha256(stem).slice(0,16), NOT the raw md stem**: real-vault stems carry backticks and CJK (`` `Flux2 Scene` 佈局的推薦實踐策略 ``), which make SurrealQL identifier escaping a parser minefield. The stem rides as a plain indexed STRING column (`card_stem`), so equality lookups (`WHERE parent = $stem`) never touch identifier syntax; the key is just a collision-free deterministic identifier.
- Minor measured facts: v3 does NOT lazily create the header-named ns/db (`ensureContextDb` bootstraps `DEFINE NAMESPACE/DATABASE IF NOT EXISTS`, hermes schema.ts precedent); `SELECT VALUE count() FROM t GROUP ALL` returns `[{count: n}]`, not `[n]`; `REMOVE NAMESPACE` requires the name.
