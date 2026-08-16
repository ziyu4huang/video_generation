**ID:** `ADR-hermes-memory-0001` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# LeanRAG retrieval concepts are ported selectively; the aggregation hierarchy is deferred

**Status:** accepted 2026-08-10 · superseded in part 2026-08-16 — ①② now ported (effort 2026-08-16-leanrag-hierarchy-port; user overturn)

## Decision (2026-08-10, as accepted)

LeanRAG (graph-centric RAG, AAAI-26) was evaluated against the knowledge-pipeline. We **port two cheap, deterministic-friendly concepts now** — ③ redundancy-aware context (frequency-voted chunk recall + relation dedup) and ⑥ entity-description summarization — into the existing `searchSemantic`/`knowledge_search` path and the dedup contract, where they compound on the just-shipped HNSW index (ticket 14) without adding an LLM-cost surface. We are **already ahead** on ④ LeanRAG's dual-store concept (HNSW side-table + SurrealDB graph supersede its Milvus+MySQL), and ⑤ LeanRAG's pluggable-extraction concept lands in ticket 03. Full analysis: `.planning/2026-08-08-knowledge-pipeline/brainstorm/leanrag-knowledge-pipeline-adoption.md`.

### 2026-08-10 rationale (historical)

The original decision also **deferred** LeanRAG's headline contribution — ① the semantic-aggregation hierarchy (recursive UMAP+GMM parent-tree) and ② its lowest-common-ancestor retrieval — as a fog/future ticket, on these concerns:

- **LLM cost** — the hierarchy is LLM-heavy (N-layers × N-clusters × N-pairs calls).
- **Determinism** — UMAP+GMM clustering is nondeterministic and python-dependent, cutting against the pipeline's deterministic-by-design philosophy.
- **Timing** — revisit when retrieval coverage, not redundancy, becomes the bottleneck.

## Decision — ①② deferral OVERTURNED (2026-08-16)

The user overturned the ①② deferral on 2026-08-16: ① the semantic-aggregation hierarchy and ② LCA tree retrieval are now ported as effort `2026-08-16-leanrag-hierarchy-port`, with mitigations that answer each 2026-08-10 concern:

- **(a) Determinism** — deterministic greedy cosine agglomerative clustering replaces GMM/UMAP: no python deps, sorted and stable assignments (fixed thresholds, entity-anchored seeds).
- **(b) LLM cost** — token-budget gating: the LLM is invoked only when a cluster's raw text exceeds the per-layer budget (LeanRAG's own condense discipline).
- **(c) Nondeterminism containment** — aggregation nodes are T2 derived markdown (regen-able, git-canonical stays the source of truth), the build is per-layer checkpointed (crash-resumable), and hierarchy construction runs batch-only at ingest/distill — never on the query path.
- **(d) Entity source unchanged** — the deterministic dictionary extractor stays the entity source; aggregation nodes are new derived multi-level MOC cards riding existing contentHash lineage.

## Consequences

- The ③⑤⑥ shipped record stands unchanged: ③ redundancy-aware context and ⑥ entity-description summarization ported into the search/dedup path; ⑤ extraction via ticket 03; ④ dual-store already ahead of LeanRAG.
- The graph gains aggregation levels: retrieval auto-expands via parent chains when a hierarchy exists; the frequency-vote formula stays authoritative for final ranking, and no-tree retrieval stays byte-identical (determinism tests adapt with seeded fixtures).
- The 2026-08-10 deferral rationale is preserved above as history, not current guidance — every concern it raised is answered by mitigation (a)–(d).
- Overturn provenance: seed `.planning/knowledge/leanrag-hierarchy-port-followup.md` (user decision + design pins) and effort dir `.planning/2026-08-16-leanrag-hierarchy-port/` (map, spec, tickets).

## Sequencing (grilled 2026-08-13)

The selective port is ticket 19. Grilling pinned its scope: port only concept ③'s
immediately-applicable part now — frequency-voted card recall + exact-contentHash
dedup, inside `searchSemantic`, on both the HNSW warm and graceful-degrade cold
paths. Concept ⑥ (entity-description summarization) and ③'s relation-dedup are
NOT in ticket 19 — they sequence after ticket 03, where typed relations and
enriched entity descriptions exist. Near-dup cosine collapse sequences to ticket
17. The adoption posture (selective port; defer the aggregation hierarchy ①②) is
unchanged.
