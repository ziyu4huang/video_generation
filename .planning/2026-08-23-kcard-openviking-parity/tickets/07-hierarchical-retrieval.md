# 07 — hierarchical retrieval with score propagation

type: grilling
blocked by: 02 (schema), 03 (capability probe)

## Question

OpenViking's retrieval differentiator vs plain vector search: global vector search to find starting directories, then a priority-queue **directory recursion with score propagation** (3-round convergence), optionally reranked. Port this to SurrealDB + kcard:

- The recursion maps to graph traversal over record links (ticket 02's `parent` edges) — breadth/priority strategy, score propagation formula, convergence rounds at ≤4 layers / 326 agg nodes.
- **Deterministic per D5/D6 — the central fork inside this ticket**: OpenViking's `search()` runs an LLM IntentAnalyzer producing typed queries; our standing decision forbids that in v1. Options: (a) caller passes type/tier filters explicitly (like `knowledge_query` today), (b) deterministic multi-query expansion (lexical + semantic + entity-match — the existing blend, α=0.18), (c) revisit D5/D6. Default posture: (b) with (a) as the typed filter; only escalate to (c) if the eval gate (ticket 09) shows a real gap.
- Cheap path: `find()` = single-query vector/lexical search without recursion — is that just today's `knowledge_query`, or a new cheaper op on the FS surface (ticket 05)?
- Blend with existing signals: semantic blend α=0.18, hotness (ticket 08, ≤±10% per D8), IDF/count baselines — define the ranking composition and its knobs.
