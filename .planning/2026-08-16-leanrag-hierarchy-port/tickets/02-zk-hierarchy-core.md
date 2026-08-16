# Ticket 02 — zk hierarchy core (blocked-by: [01])

Goal: Pure aggregation module src/hierarchy.ts in pi-agent-ext-knowledge-card.

Scope: cluster(vectors, {threshold, minSize}) greedy cosine agglomerative (deterministic, sorted); buildLayer({cards, entities, embedFn, summarizeFn, tokenBudget}) → {nodes, parent links, llmCallsMade}; checkpoint read/write helpers (hierarchy-layer-N.json); parentChain(cardId) reader. No store/vector imports.

Acceptance: unit tests with deterministic fake vectors pin cluster boundaries, stopping rule (≤4 clusters or depth cap), budget gating (0 LLM calls under threshold), checkpoint round-trip + resume-mid-tree.
