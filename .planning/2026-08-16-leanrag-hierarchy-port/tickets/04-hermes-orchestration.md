# Ticket 04 — hermes orchestration (blocked-by: [02])

Goal: Batch build hook in hermes walk-and-ingest.

Scope: post-ingest phase (fire-and-forget, vector-backfill pattern): gather cards+entities via seam, inject embedFn (card_vectors/cache path, skip when unavailable) + summarizeFn (llm-chat with per-layer token budget), call zk buildLayer loop with checkpoints; DEVOPS-free config knob (hierarchyEnabled default on, env override).

Acceptance: e2e — ingest fixture corpus → tree built with N layers; surreal-down → skip clean; kill-mid-build → resume completes.

## Progress

04a done: core-interface KnowledgePipeline + buildHierarchy (HierarchyBuildOptions/Result); zk hierarchy-build.ts (108 LOC) loop-with-checkpoints wired into seam; 4 orchestration tests green (3-layer, resume, skip, gating). 04b (hermes hook) pending.
