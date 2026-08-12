# LeanRAG upstream provenance

This package's knowledge-search path was cross-checked against **LeanRAG**
(graph-centric RAG, AAAI-26, arXiv:2508.10391, `/Users/huangziyu/proj/LeanRAG`).
This file is the in-code index that tracks which LeanRAG concept each module
implements, supersedes, or will port — so the upstream lineage is discoverable
from the source, not just from planning docs.

- **Decision record:** `docs/adr/0001-leanrag-selective-port.md` (selective-port posture).
- **Analysis:** `.planning/2026-08-08-knowledge-pipeline/brainstorm/leanrag-knowledge-pipeline-adoption.md`.
- **Build ticket:** `.planning/2026-08-08-knowledge-pipeline/tickets/19-leanrag-redundancy-aware-retrieval.md`.
- **Convention:** every annotated module carries a greppable `@upstream(LeanRAG)`
  block. `grep -rn "@upstream(LeanRAG)" src` lists them all.

## Concept → module map

| # | LeanRAG concept | Our module | Status | Ticket / ADR |
|---|---|---|---|---|
| ④ | Dual store (vector ANN + graph) | `src/store/surreal/vector-store.ts`, `src/store/surreal/schema.ts`, `src/store/semantic-search.ts` (warm path) | **Have / ahead** — HNSW side-table supersedes Milvus IVF_FLAT/IP; SurrealDB `RELATE` supersedes MySQL+CTE | ADR-0001 |
| ③ | Redundancy-aware context (frequency-voted recall + dedup) | `src/store/semantic-search.ts` | **Porting** — ticket 19 | ticket 19, ADR-0001 |
| ⑥ | Entity-description summarization | `src/merge-union.ts` (partial) | **Deferred** — full condense needs ticket 03 | ticket 03, ADR-0001 |
| ⑤ | Pluggable extraction (dict vs LLM few-shot) | knowledge-card `entities.ts` (deterministic tagging; different pkg) | **Design home** — ticket 03 | ticket 03 |
| ① | Semantic-aggregation hierarchy (parent-tree) | — | **Deferred (fog/future)** — LLM-heavy, cuts against deterministic-by-design | ADR-0001 |
| ② | Hierarchical LCA retrieval | — | **Deferred** (depends on ①) | ADR-0001 |

## Status legend

- **Have / ahead** — already implemented; supersedes the LeanRAG equivalent.
- **Porting** — a build ticket is open to port it.
- **Deferred** — sequenced after a prerequisite ticket, or parked as fog/future.
- **Design home** — the concept lands in a named ticket's design.

## References

- LeanRAG source: `_cluster_utils.py` (①), `query_graph.py` (②③),
  `database_utils.py` (③④), `CommonKG/` + `GraphExtraction/` (⑤),
  `deal_triple.py` (⑥).
- Our tickets: 03 (typed entity-relation graph), 14 (HNSW index — shipped),
  17 (near-dup depth-pass), 19 (LeanRAG selective port — redundancy-aware retrieval).
