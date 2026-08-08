---
status: active
---
# Knowledge pipeline — memory/files -> cards -> graph -> DB-CRUD -> obsidian

## Destination
A single card-agnostic knowledge pipeline: any input (memory OR files: md/txt/pdf/docx/pptx/images, or a whole directory the agent walks) -> knowledge-cards (git-canonical md) -> two-layer knowledge graph -> DB-accelerated CRUD (SurrealDB+embed for query/duplicate/conflict; SQLite for non-embed CRUD) -> obsidian vault on disk. DB<->md bidirectional sync. Orchestration lives in the memory-card extension (hermes) as the spine; knowledge-card (zk) provides graph/ingest/RAG primitives. The pipeline also self-applies to wayfinder's own .planning/<effort> for CRUD/query/duplicate/conflict/staleness.

## Notes
- UNIFIED EFFORT — consolidates 5 prior efforts (see Absorbed efforts). Architecture spine: hermes (memory-card) = ORCHESTRATOR + store; zk (knowledge-card) = graph/ingest/RAG primitives provider; obsidian = vault sink. (Revises the original "graph/ingest/RAG HIGH in zk" call — ticket 06.)
- Backend rule: embed ONLY in SurrealDB (+ lm-studio model); SQLite is non-embed CRUD only — no sqlite-vec embed. (Sharpens ticket 04.)
- Reuse: knowledge-card (zk_*), obsidian (vault), hermes-memory (section-md + backend-ab), file2md (extractPdfText via mupdf). SurrealDB v3.2.3 @127.0.0.1:8000. lm-studio hosts embed + vision (google/gemma-4-12b-qat, user-evaluated; confirm id at impl time).
- Platform: Apple Silicon MPS, bfloat16 native, MLX stack (per CLAUDE.md).
- Test corpus: image path TBD; .planning path = this repo's own .planning/.

### Absorbed efforts (folded in 2026-08-08)
- 2026-08-08-pi-agent-ext-knowledge-card-obsidian-surealdb-or — foundation; tickets 01-05 migrated here as 01-05. SUPERSEDED.
- 2026-08-08-let-s-continue-our-previous-goal-pi-agent-ext-kn — delta (images + wayfind self-CRUD); tickets migrated here as 06-10. ABSORBED (dir removed).
- 2026-07-30-file2md-for-pdf-... — PDF extractor (mupdf+VLM hybrid VERDICTED; feeds ticket 02). Live prototype ticket 04 stays there. ABSORBED.
- 2026-07-28-hermes-surrealdb-graph-search — graph-augmented recall via RELATE edges, SHIPPED (feat/hermes-surrealdb-graph-search, 758 tests green). Prior art for tickets 03/10. ABSORBED.
- 2026-07-29-brainstorm-to-improve-pi-agent-ext-hermes-memory — embed/backend decisions (ChromaDB rejected; sqlite-vec/SurrealDB-for-graph). Drift tickets closed citing ticket 04. ABSORBED.
- Spawned by 06: ticket 11-core-interface-package (scaffold core-interface pkg + migrate __pi* seams; blocks 06's typed impl).

## Decisions so far
- 01: unified Card {id, kind, content, frontmatter, embed?, graph?}; hermes store kind-agnostic via pluggable serializer; dedup = single store call-site behind pluggable strategy. CLOSED.
- 02: extractors — md/txt native; pdf=mupdf via file2md (hybrid mupdf-body+VLM-figures, per file2md verdict); docx=mammoth; pptx=pptxtojson; one card per section/page/slide (~512 tok); provenance frontmatter. CLOSED.
- Hermes-as-spine (revise 01): hermes owns pipeline orchestration + store; zk = graph/ingest/RAG primitives provider. -> ticket 06
- Image input: BOTH OCR + vision-LLM (google/gemma-4-12b-qat via lm-studio), one merged card. -> ticket 07
- Wayfind card granularity: per-ticket (tickets/NN.md = card kind=planning-ticket; map.md = index). -> ticket 08
- Staleness: source-dependency graph (deps declared; re-validate on change). -> ticket 10
- Carry-over (feeds 04): embed = SurrealDB-only (+ lm-studio); SQLite non-embed CRUD only.

## Not yet specified
- Image embed strategy (text-embed of merged content vs +CLIP image-vector). -> ticket 07
- Image-card provenance field set; OCR library pick. -> ticket 07
- Directory-walk policy (recurse depth, image-by-default, skip-binary). -> tickets 06/07
- Staleness dependency types + how a closed decision declares deps. -> ticket 10
- Default backend (SQLite vs SurrealDB) for non-embed path — defers to 04 A/B.

## Out of scope
- Audio/video input (text + images only).
- Real-time multi-user collaboration (single-user, multi-worktree git-merge model).
- Re-deciding 01/02 (closed) — those stand.
