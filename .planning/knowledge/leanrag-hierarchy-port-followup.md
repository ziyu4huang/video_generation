# LeanRAG ①② hierarchy port — follow-up effort seed (decided 2026-08-16)

User decision (grilling, 2026-08-16): port LeanRAG ① semantic-aggregation hierarchy + ② LCA tree retrieval as a SEPARATE follow-up effort AFTER `2026-08-16-hermes-leanrag-simplify` completes, on the cleaned-up base. This overturns ADR-hermes-memory-0001's deferral — the ADR rewrite is the FIRST action of that follow-up effort (not now; the simplification effort still honors the ADR as-is).

## Design pins (settled now, implement later)
- **Build timing = batch at ingest/distill** (LeanRAG `build_graph.py` shape): after cards+entities land, cluster → LLM-summarize → repeat until few top clusters, with per-layer checkpoints (crash-resumable) and token-budget-gated LLM condense calls (LLM only when raw relation text exceeds the layer budget). Offline; never blocks ingest.
- **Retrieval = auto tree-expansion when a hierarchy exists** (LeanRAG native): knowledge_search automatically walks parent paths to collect aggregation summaries + relation paths. NOTE: this changes existing search results; determinism tests will need adaptation at that time. Frequency-vote formula still applies to final ranking.
- Entity source stays the **dictionary extractor** (deterministic); aggregation nodes are NEW derived cards.
- **kcard abstraction mapping**: LeanRAG entity ↔ card entities; aggregation node ↔ auto-generated multi-level MOC card (zk already has MOC regen — the delta is cluster+summarize making it a multi-level tree); root ↔ top-level MOC; source_id-union provenance rides existing contentHash lineage.

## Scope anchor
Target: bun-apps/pi-agent-ext-knowledge-card (zk layer) + knowledge_search in hermes-memory. Do NOT chart tickets until the simplification effort is done.
