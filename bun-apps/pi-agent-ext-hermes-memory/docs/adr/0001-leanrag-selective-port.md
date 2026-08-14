**ID:** `ADR-hermes-memory-0001` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# LeanRAG retrieval concepts are ported selectively; the aggregation hierarchy is deferred

LeanRAG (graph-centric RAG, AAAI-26) was evaluated against the knowledge-pipeline. We **port two cheap, deterministic-friendly concepts now** — redundancy-aware context (frequency-voted chunk recall + relation dedup) and entity-description summarization — into the existing `searchSemantic`/`knowledge_search` path and the dedup contract, where they compound on the just-shipped HNSW index (ticket 14) without adding an LLM-cost surface. We **defer** LeanRAG's headline contribution — the semantic-aggregation hierarchy (recursive UMAP+GMM parent-tree) and its lowest-common-ancestor retrieval — as a fog/future ticket, because it is LLM-heavy (N-layers × N-clusters × N-pairs calls) and cuts against the pipeline's deterministic-by-design philosophy; revisit when retrieval coverage, not redundancy, becomes the bottleneck. We are **already ahead** on LeanRAG's dual-store concept (HNSW side-table + SurrealDB graph supersede its Milvus+MySQL), and LeanRAG's pluggable-extraction concept lands in ticket 03. Full analysis: `.planning/2026-08-08-knowledge-pipeline/brainstorm/leanrag-knowledge-pipeline-adoption.md`.

## Sequencing (grilled 2026-08-13)

The selective port is ticket 19. Grilling pinned its scope: port only concept ③'s
immediately-applicable part now — frequency-voted card recall + exact-contentHash
dedup, inside `searchSemantic`, on both the HNSW warm and graceful-degrade cold
paths. Concept ⑥ (entity-description summarization) and ③'s relation-dedup are
NOT in ticket 19 — they sequence after ticket 03, where typed relations and
enriched entity descriptions exist. Near-dup cosine collapse sequences to ticket
17. The adoption posture (selective port; defer the aggregation hierarchy ①②) is
unchanged.
