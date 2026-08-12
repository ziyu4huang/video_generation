# LeanRAG → knowledge-pipeline: concept breakdown & adoption analysis

- **Date:** 2026-08-13
- **Status:** analysis — feeds ADR-0001 (selective-port decision)
- **Source:** `/Users/huangziyu/proj/LeanRAG` (LeanRAG, AAAI-26, arXiv:2508.10391)
- **Scope:** map LeanRAG's base concepts onto the `2026-08-08-knowledge-pipeline` effort and decide what to port. Not a build plan.

## What LeanRAG is

LeanRAG is a **graph-centric RAG** (GraphRAG / LightRAG / HiRAG lineage), NOT a chunk-vector RAG. Retrieval runs over **entities + relations + aggregated communities**, not over raw chunk embeddings. The "Lean" thesis is **retrieval redundancy reduction**: flat/graph baselines flood the context window with overlapping entity/relation descriptions; LeanRAG claims ~46% lower retrieval redundancy and fewer retrieved tokens by aggregating fine-grained entities into summary nodes and traversing the aggregation tree for evidence.

## LeanRAG's pipeline (4 stages)

1. **Index** — `file_chunk.py`: tiktoken sliding window → `{hash_code: md5(text), text}`. `hash_code` is the join key threading the whole system.
2. **KG extraction** (two interchangeable front-ends) → `entity.jsonl` + `relation.jsonl`:
   - `CommonKG/` — dictionary-anchored: DBpedia/Wikipedia seed entities + Aho-Corasick matching + iterative BFS layer expansion (`level_num`); LLM extracts triples anchored on matched head entities.
   - `GraphExtraction/` — LLM few-shot with gleaning (nano-graphrag style).
   - Both merge duplicate entities (`deal_triple.py`) and summarize long merged descriptions.
3. **Semantic aggregation** (`build_graph.py` + `_cluster_utils.py`) — the "Lean" core: embed entity descriptions (BGE-M3, 1024-d) → recursive **UMAP(2D) + GMM(BIC)** clustering layer by layer until a single root; each cluster is LLM-summarized (`aggregate_entities`) into an **aggregate node** that becomes its members' `parent`, building a `parent`/`level` tree. Persisted to **Milvus-lite** (vector, IVF_FLAT/IP) + **MySQL** (entities/relations/communities as flat tables + one recursive CTE).
4. **Query** (`query_graph.py`) — embed query → Milvus ANN top-K leaf entities → for each pair walk `parent` chains up to **lowest common ancestor**, gathering + dedup'ing inter-node relations → look up community `findings` → **frequency-vote** the entities' `source_id` chunk-hashes (top-K most-cited) → assemble a 4-block context → generate.

## The six base concepts

1. **Semantic-aggregation hierarchy** — recursive UMAP+GMM clustering producing a `parent`-pointer tree of LLM-summarized aggregate nodes. (`_cluster_utils.py::Hierarchical_Clustering`)
2. **Hierarchical LCA retrieval** — anchor top-K leaves, walk each pair's `parent` chain to the lowest common ancestor, gather evidence upward. (`query_graph.py::get_reasoning_chain`)
3. **Redundancy-aware context** — (a) dedup relation descriptions via `set()`, (b) **frequency-vote** chunk recall: count `source_id` hashes across anchored entities, keep top-K most-cited. (`query_graph.py` + `database_utils.py::get_text_units`)
4. **Dual store** — Milvus (vector ANN, every node at every level, `level` filter) + MySQL (tree edges + relations + communities), joined by `entity_name`/`source_id`.
5. **Pluggable extraction front-ends** — CommonKG (dictionary-anchored, precision) vs GraphExtraction (LLM few-shot, recall), both emitting the same canonical `entity.jsonl`/`relation.jsonl`.
6. **Entity-description summarization** — merge same-entity descriptions with ` | `; if merged exceeds a threshold, LLM-condense to ≤N tokens before embedding/clustering. (`deal_triple.py`, `summary_entities`)

## Mapping onto our pipeline

| # | LeanRAG concept | Our status | Verdict |
|---|---|---|---|
| 4 | Dual store (vector ANN + graph) | **Have** — HNSW side-table `card_vectors` (ticket 14, DIM 768 COSINE F32) + SurrealDB native graph | **Already ahead.** HNSW supersedes Milvus IVF_FLAT/IP; SurrealDB `RELATE` beats MySQL flat-tables + recursive-CTE emulation. No action. |
| 5 | Pluggable extraction (dict vs LLM few-shot) | **Design home exists** — ticket 03 pins hybrid schema + opt-in LLM extraction (`kg.llm`, default OFF) + deterministic entity tagging | Lands in **ticket 03**. Pick the method (dictionary-anchored vs LLM-few-shot) when building. |
| 3 | Redundancy-aware context (dedup + frequency-voted recall) | **Partial** — HNSW top-K + FTS, but no relation-dedup or frequency-voted chunk recall | **Port now (selective).** Drop into `searchSemantic`/`knowledge_search`. Compounds on just-validated HNSW. Deterministic-friendly. |
| 6 | Entity-description summarization | **Partial** — merge-union exists; no condense | **Port now (selective).** Folds into the dedup contract (C6) / ticket 17. |
| 1 | Semantic-aggregation hierarchy (parent-tree) | **Not present** | **Defer.** Would expand ticket 03's flat typed graph into a hierarchy; LLM-cost surface = N-layers × N-clusters × N-pairs calls. Cuts against deterministic-by-design. Capture as fog/future ticket. |
| 2 | Hierarchical LCA retrieval | **Not present** | **Defer** (depends on 1). |

## Decision (recorded in ADR-0001)

- **Port selectively now:** ③ redundancy-aware context + ⑥ entity summarization → existing knowledge-search + dedup path. New small build ticket.
- **Defer:** ① + ② (aggregation hierarchy + LCA retrieval) as a fog/future ticket — revisit when retrieval coverage, not redundancy, is the bottleneck.
- **Already ahead:** ④ (storage).
- **Design home:** ⑤ (extraction method) → ticket 03.

## Open design questions for the selective port (next grilling round)

- **Where does frequency-voted chunk recall live?** In `searchSemantic` post-HNSW, or a new context-assembly seam? (Ticket 14's `searchSemantic` currently returns top-K cards directly.)
- **What is a "chunk" in our model?** LeanRAG chunks raw docs; we have cards. Is the unit a card, a card-section, or both? This drives frequency-vote semantics.
- **Relation-dedup scope:** only meaningful once ticket 03's typed relations exist, so ③'s relation-dedup is gated behind 03; only chunk-recall + entity-summarization port now. Confirm.
- **Entity-summarization trigger:** threshold + model (reuse the embed LM Studio endpoint? a separate condense call?) + where condensed text lives (derived only, never the canonical card md).
- **Overlap with ticket 17 (dedup depth-pass) and C6 (dedup-into-contract):** is ⑥ a subset of those or a distinct concern?

## References

- LeanRAG: `/Users/huangziyu/proj/LeanRAG/{file_chunk,build_graph,query_graph,_cluster_utils,database_utils}.py`, `CommonKG/`, `GraphExtraction/`, `prompt.py`, `config.yaml`.
- Our pipeline: ticket 03 (`03-design-two-layer-knowledge-graph.md`), ticket 14 (`14-build-embed-index.md`), tickets 17/18, convergence moves C1/C5/C6 (`.planning/2026-08-10-hermes-architecture-deepening/`).
- Decision record: `bun-apps/pi-agent-ext-hermes-memory/docs/adr/0001-leanrag-selective-port.md`.
