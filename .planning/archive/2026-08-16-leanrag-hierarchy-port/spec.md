# Spec — leanrag-hierarchy-port

## Problem
The knowledge graph is flat: retrieval redundancy is controlled (③ shipped) but coverage has no structure — no aggregation levels, no tree-walk evidence expansion. LeanRAG's ①② (deferred by ADR-hermes-memory-0001 as LLM-heavy/nondeterministic) are the missing abstraction layer; the user overturned that deferral 2026-08-16 with mitigations (deterministic clustering, token-budget gating, checkpoints).

## Solution
Port ①② with LeanRAG's own discipline: zk gains a pure aggregation module (cluster/summarize/tree-build with injected embedFn+summarizeFn), hermes gains the batch orchestration hook at ingest/distill time, retrieval auto-expands via parent chains. Aggregation nodes materialize as multi-level MOC cards in the vault (git-canonical, T2 derived).

## User Stories
- As an agent searching knowledge, my evidence automatically includes aggregation summaries + cross-topic paths when a hierarchy exists — better coverage without re-querying.
- As the operator, hierarchy builds offline at ingest, resumes after crashes (per-layer checkpoints), and costs LLM tokens only on genuinely-over-threshold clusters.
- As a maintainer, the aggregation core is pure/deterministic and testable without a vector store (callables injected).

## Implementation Decisions
1. Ticket 01 rewrites ADR-hermes-memory-0001 (records the overturn + mitigations).
2. zk: hierarchy.ts — cluster(vectors, threshold), buildLayer(entities, cards, embedFn, summarizeFn, budget), checkpoints, parent-chain reader. No store imports.
3. hermes: walk-and-ingest post-ingest phase (best-effort, fire-and-forget like vector backfill) calls zk hierarchy via the pipeline seam with injected embedFn (card_vectors path) + summarizeFn (llm-chat).
4. zk retrieveRecords: after ranking seeds, walk parent chains; merge aggregation summaries as evidence cards; final ranking unchanged (freq-vote pinned formula stays authoritative).
5. Aggregation MOC cards: kind=planning-agnostic derived, frontmatter {parent, entities (union), sources (contentHash union), layer, clusterSize}; md-canonical; graph-health regen extended to prune orphaned nodes.
6. Token budget: per-layer condense budget (LeanRAG (max_depth-layer)*80 analog, config'd); LLM call only over threshold.
7. Fallbacks: no embeds (surreal down) → build skips this cycle; existing flat retrieval behavior when no tree exists (byte-identical).

## Testing Decisions
- zk unit tests with fake embedFn/summarizeFn (deterministic vectors) pin: clustering thresholds, layer stopping, checkpoint resume, parent-chain reads, budget gating (LLM never called under threshold).
- Retrieval: auto-expansion ON-tree vs OFF-tree (no tree = byte-identical results — pin it); determinism tests adapted with explicit seed fixtures.
- hermes: orchestration hook fires post-ingest, skips on embed-unavailable, crash-resume via checkpoints.
- Full suites green: zk, hermes, tool-gate, pre-push 17 gates.

## Out of Scope
- GMM/UMAP clustering, python deps.
- Replacing the dictionary extractor (entity source unchanged).
- freq-vote formula changes; two-path retrieval unification (ADR-pi-agent-0004 stands).
- Real-time/lazy tree building (batch only).
