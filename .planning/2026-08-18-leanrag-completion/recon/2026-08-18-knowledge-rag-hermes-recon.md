# Read-only recon: .planning/ knowledge-extract / embeddings / RAG / hermes-memory efforts

Date: 2026-08-18 · Repo: /Users/huangziyu/proj/video_generation__memory · No edits made.

## (a) Full effort folder list (.planning/, 26 dated efforts)

- 2026-07-31-let-s-continue-to-improve-base-on-known-upstream
- 2026-08-08-knowledge-pipeline
- 2026-08-10-hermes-architecture-deepening
- 2026-08-15-archify-webui-html
- 2026-08-15-subagent-dynamic-budgets
- 2026-08-15-tool-gate-complete-redesign
- 2026-08-15-zk-spawn-interactive-ui
- 2026-08-16-hermes-leanrag-simplify
- 2026-08-16-leanrag-hierarchy-port
- 2026-08-16-power-browser-tool
- 2026-08-16-power-tool-rearch
- 2026-08-16-simplefied-redesign-make-less-code-to-archive
- 2026-08-16-skill-recon-report
- 2026-08-16-tool-gate-qa-harness-generalization
- 2026-08-16-webui-cards-ux2
- 2026-08-16-webui-event-cards
- 2026-08-16-webui-present-adoption
- 2026-08-16-webui-tab-views
- 2026-08-16-webui-tui-parity
- 2026-08-16-webui-v2-cards-first
- 2026-08-16-webui-v3-simplify
- 2026-08-16-webui-view-notifications
- 2026-08-17-knowledge-pipeline-polish
- 2026-08-17-webui-dynamic-shell
- 2026-08-17-webui-report-iframe-fix
- 2026-08-17-webui-report-persist
- 2026-08-17-webui-report-raw
- 2026-08-17-webui-report-tool
- Plus non-effort dirs: audit/, done/, knowledge/ (shared notes incl. leanrag-hierarchy-port-followup.md), plans/, recon/, specs/, CONVENTIONS.md, REVIEW-*.md, UPSTREAM-SOURCES.md, progress.md.

Related specs/ (embeddings/RAG cluster): embedding-server-benchmark, embed-mlx-server (+quality-check, +simplification), knowledge-pipeline-phase2, hermes-memory-backend-abstraction, hermes-memory-surrealdb-backend.

## (b) Top relevant efforts

### 1. 2026-08-17-knowledge-pipeline-polish (status: complete, map 08-18)
- **Goal**: Land 4 decided levers from wayfind map (../done/2026-08-17-knowledge-pipeline-simplify) per locked spec — L1 CLI retirement (zk loop/merge + kcard-loop cmd + mergeDuplicates seam), L2 embedding leaf hoist to @repo/pi-agent-core-interface, L3 trivia removal (INTERVIEW_PROMPT), L4 docs truth (hermes KNOWLEDGE-LAYER rewrite). Zero behavior change; pinned surfaces untouchable (hermes 6-tool ≤2100 tok; zk 4 tools).
- **Tickets 00–05: ALL DONE** (Resolutions recorded; acceptance.md: 4/4 structure targets MET, gates green).
- **Open frontier**: none — "Not yet specified: (none — spec locked)". Effort complete.

### 2. 2026-08-16-leanrag-hierarchy-port (status: complete, D1 overturns ADR-hermes-memory-0001)
- **Goal**: Port LeanRAG ① semantic-aggregation hierarchy (entity cards → deterministic greedy cosine clustering → LLM-summarized aggregation MOC nodes, contentHash lineage unions, per-layer checkpoints) + ② retrieval auto tree-expansion (≤3 lineage-matched node summaries as viaTree evidence cards, ranking untouched) onto cleaned 6-tool hermes base. Deps injected (embedFn, summarizeFn); no sklearn/UMAP; zk stays vector-store-free.
- **Tickets 01–08: ALL DONE** (ADR rewrite, zk hierarchy core, MOC cards, hermes orchestration 04a/04b-1/04b-2, tree expansion, budget/config HIERARCHY_DEFAULTS threshold .72 maxDepth 3, docs provenance, acceptance).
- **Open frontier**: Fog items all resolved per map ("Effort complete 2026-08-16. ①② shipped"). Residual fog noted at impl time: hermes walk-and-ingest orchestration seam arg shape (verified at impl), Surreal-down degradation (hierarchy skips, same as cold path).

### Honorable mention: 2026-08-16-hermes-leanrag-simplify (predecessor, complete)
- 11/11 tickets done: unified search tool, supersede/fold, repo consolidation, surreal default fallback, dedup, cut LLM-KG+commands, c4 index split, dead code, schema-cost hard pin, acceptance.

## Open decision frontier (net)
None open across the three efforts — all complete with recorded resolutions. Next-step breadcrumbs live in .planning/knowledge/leanrag-hierarchy-port-followup.md (seed of hierarchy-port; followups appear consumed) and .planning/done/2026-08-17-knowledge-pipeline-simplify/ (census source for polish). Larger umbrella 2026-08-08-knowledge-pipeline (map.md 23KB, 21 tickets, sdd/, plans/, specs/) predates and fed these; not re-read in depth (budget).
