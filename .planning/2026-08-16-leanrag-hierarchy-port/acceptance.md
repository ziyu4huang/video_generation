# Acceptance — leanrag-hierarchy-port (2026-08-16)

## Coverage delta
Tree vs flat evidence: retrieval now appends lineage-matched aggregation summaries (≤3, layer-desc) when a hierarchy exists — broader evidence per query without re-querying (pinned by retrieve-tree tests); flat behavior byte-identical when no tree (golden).

## LLM discipline
Gating proven through the DEFAULT path: huge budget → llmCalls 0, fetch never called. Per-layer budget halves per depth (floor 1200 chars-proxy); chatJson-backed summaries with deterministic truncation fallback (LM-Studio-down safe).

## Determinism
Clustering = greedy cosine agglomerative (sorted, no RNG); checkpoints resume-mid-tree; aggregation nodes = T2 derived md (regen-able, heal-pruned, never supersede user cards).

## Tickets
01 ADR-hermes-memory-0001 superseded-in-part (3a5ceccc) · 02 core 281+328 (50cec93b) · 03 MOC cards (e638100f) · 04 seam+orchestration+hook (dc9bb246/bbc5816e/02b39e31) · 05 tree expansion (ed963faa) · 06 budget+config (e5b692cd) · 07 docs (43475cd2) · 08 this.

## Gates
zk 473/0 + tsc clean · hermes 1620/0 + tsc clean · core-interface 26/0 · test:adr 19/0.
