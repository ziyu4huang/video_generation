# Ticket 04 — hermes orchestration (blocked-by: [02])

Goal: Batch build hook in hermes walk-and-ingest.

Scope: post-ingest phase (fire-and-forget, vector-backfill pattern): gather cards+entities via seam, inject embedFn (card_vectors/cache path, skip when unavailable) + summarizeFn (llm-chat with per-layer token budget), call zk buildLayer loop with checkpoints; DEVOPS-free config knob (hierarchyEnabled default on, env override).

Acceptance: e2e — ingest fixture corpus → tree built with N layers; surreal-down → skip clean; kill-mid-build → resume completes.

## Progress

04a done: core-interface KnowledgePipeline + buildHierarchy (HierarchyBuildOptions/Result); zk hierarchy-build.ts (108 LOC) loop-with-checkpoints wired into seam; 4 orchestration tests green (3-layer, resume, skip, gating). 04b (hermes hook) pending.
04b-1 done: cards optional in HierarchyBuildOptions; zk loadKbCards (id-preferring, sources=id∪frontmatter, agg-L* skipped); loader test green; suite 465/0.

## Resolution
DONE. 04a: seam method (KnowledgePipeline.buildHierarchy) + zk orchestration loop w/ per-layer checkpoints. 04b-1: zk kbDir loader (frontmatter-id-preferring, lineage sources = id ∪ frontmatter, agg-L*-* skipped). 04b-2: hermes fire-and-forget hook — embedFn via defaultEmbedder (LM-Studio-down → caught warn+skip), hierarchyEnabled knob (default on, PI_HIERARCHY_DISABLED env), zk owns the deterministic default summarizer (chatJson-backed default lands with ticket 06). Dep-guard honored: hermes→zk via seam only. e2e coverage: zk hierarchy-build tests (3-layer, resume, skip, gating, loader) + hermes buildHierarchyCall tests (5).
