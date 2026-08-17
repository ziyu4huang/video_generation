# Ticket 02 — zk hierarchy core (blocked-by: [01])

**Status:** done · 2026-08-17
**Resolution:** hierarchy.ts 281 LOC (cluster/buildLayer/checkpoints/parentChain, D4-D6); 20 tests green (boundaries, budget gating 0-LLM, depth cap, checkpoint resume, cycle-safe chain); typecheck clean.


Goal: Pure aggregation module src/hierarchy.ts in pi-agent-ext-knowledge-card.

Scope: cluster(vectors, {threshold, minSize}) greedy cosine agglomerative (deterministic, sorted); buildLayer({cards, entities, embedFn, summarizeFn, tokenBudget}) → {nodes, parent links, llmCallsMade}; checkpoint read/write helpers (hierarchy-layer-N.json); parentChain(cardId) reader. No store/vector imports.

Acceptance: unit tests with deterministic fake vectors pin cluster boundaries, stopping rule (≤4 clusters or depth cap), budget gating (0 LLM calls under threshold), checkpoint round-trip + resume-mid-tree.
