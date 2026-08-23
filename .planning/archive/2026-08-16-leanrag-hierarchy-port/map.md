---
effort: 2026-08-16-leanrag-hierarchy-port
status: complete
created: 2026-08-16
pipeline: wayfind→superpowers
seed: .planning/knowledge/leanrag-hierarchy-port-followup.md
---

# Map — leanrag-hierarchy-port

## Destination
LeanRAG ① (semantic-aggregation hierarchy) + ② (LCA tree retrieval) ported onto the cleaned 6-tool hermes base: entity cards clustered per layer into LLM-summarized aggregation nodes (multi-level auto-MOC, contentHash-lineage unions, per-layer checkpoints), knowledge retrieval auto-expands via parent paths when a tree exists. Deterministic clustering (no sklearn/UMAP deps), dictionary extractor stays the entity source, freq-vote formula untouched as final ranking.

## Decisions
- D1 (user Q1-B): separate follow-up effort, executes on post-#1556 base. Overturns ADR-hermes-memory-0001 — rewrite is ticket 01 (first action).
- D2 (user Q2-A): batch build at ingest/distill — after cards+entities land: cluster → summarize → repeat until ≤4 top clusters or depth cap; per-layer checkpoint JSON in kb dir; never blocks ingest (best-effort, resumable).
- D3 (user Q3-B): retrieval auto tree-expansion when hierarchy exists (LeanRAG native). Expansion inside zk retrieveRecords core so both retrieval paths benefit (ADR-pi-agent-0004 paths unchanged). Determinism tests adapt honestly.
- D4 (LeanRAG pattern): dependency-injected callables — zk aggregation module receives embedFn + summarizeFn; hermes supplies (card_vectors via existing embed infra; llm-chat for summaries). Zero new deps, zk stays vector-store-free.
- D5: clustering = deterministic greedy cosine agglomerative (fixed threshold, entity-anchored seeds); NO GMM/UMAP ports (anti-deterministic, python-dep).
- D6: LLM only for per-cluster summaries + relation condense when raw text exceeds per-layer token budget (LeanRAG token-budget gating).
- D7: aggregation nodes = derived multi-level MOC cards (frontmatter: parent, entities-union, sources union via contentHash lineage); md stays git-canonical (3-tier drift honored — nodes are T2 derived, regen-able).

## Fog
- hermes walk-and-ingest orchestration point for the build phase (8e-style step) — verify seam arg shape at implementation.
- Surreal-down path: hierarchy build skips (embeds unavailable) — same degradation class as today's cold path.
- Determinism-test surface for auto-expansion — enumerate before adapting.
- Effort complete 2026-08-16. ①② shipped; deterministic + budget-gated per mitigations D5/D6.

## Tickets
- (charted below)

## Cross-effort links
- **Built-on-by**: `.planning/2026-08-22-context-lifecycle` — its agg-L* tree + DI'd
  summarizeFn/budget gates (D2/D4/D6 here) become that effort's L1 retrieval tier; its D7
  (md-git-canonical, derived regen-able) is why that effort rejected OpenViking-style
  `.abstract.md`/`.overview.md` sidecars in favor of frontmatter `summary:`.
