---
status: active
---
# Knowledge pipeline — memory/files -> cards -> graph -> DB-CRUD -> obsidian

## Milestone — Spine COMPLETE (2026-08-09)

The hermes spine is built end-to-end. Typed seam + card-agnostic store + orchestrator all shipped:

- **Ticket 12** — typed seam scaffolded: `@repo/pi-agent-ext-core-interface` (`SEAM_KEYS` 8 keys + `publishSeam`/`readSeam` + `KnowledgePipeline` interface). **PR #1131** (squash `3793a390`).
- **Ticket 06a** — card-agnostic store: `Card{kind}` + pluggable `CardSerializer` (memory/knowledge) + pluggable `DedupStrategy`; memory-cards coexist byte-identical, knowledge-cards round-trip vault-md. **PR #1141** (squash `61e6019a`).
- **Ticket 06b** — spine orchestrator: `walkAndIngest` (policy walk + family-detect + ingest + heal + DB-mirror into the unified store) + `healGraph` published as a 5th `KnowledgePipeline` seam leaf + `knowledge_search`/`knowledge_ingest` tools + Tier-1 drift stub. **PR #1146** (squash `3bd0d694`).

**Now unblocked:** 07 (image cards), 09/10 (planning sync + staleness), 13 (memory-card graduation). 08 shipped.
**Effort-query phasing:** 08 shipped; 09/10 (full planning-card pipeline) = PHASE 2; PHASE 1 = ticket 15 (lightweight list + search over .planning, read-only, standalone — UNBLOCKED).
**Still-open build tracks:** 03 (typed entity-relation graph layer), 14 (embed/vector index build — SurrealDB HNSW + lazy backfill; UNBLOCKED, 04 closed), 05 (full 3-tier drift — 06b stubbed Tier-1 only), 15 (effort-query Phase 1 — lightweight list + search over .planning, read-only; UNBLOCKED, standalone — Phase 2 = 08/09/10).
**Known issue:** #1130 — `__piRateLimitState` orphan (pi-agent-ext-subagent) unregistered → `test:seam` red.

## Destination
A single card-agnostic knowledge pipeline: any input (memory OR files: md/txt/pdf/docx/pptx/images, or a whole directory the agent walks) -> knowledge-cards (git-canonical md) -> two-layer knowledge graph -> DB-accelerated CRUD (SurrealDB+embed for query/duplicate/conflict; SQLite for non-embed CRUD) -> obsidian vault on disk. DB<->md bidirectional sync. Orchestration lives in the memory-card extension (hermes) as the spine; knowledge-card (zk) provides graph/ingest/RAG primitives. The pipeline also self-applies to wayfinder's own .planning/<effort> for CRUD/query/duplicate/conflict/staleness.

## Notes
- UNIFIED EFFORT — consolidates 5 prior efforts (see Absorbed efforts). Architecture spine: hermes (memory-card) = ORCHESTRATOR + store; zk (knowledge-card) = graph/ingest/RAG primitives provider; obsidian = vault sink. (Revises the original "graph/ingest/RAG HIGH in zk" call — ticket 06.)
- Backend rule: embed ONLY in SurrealDB (+ lm-studio model); SQLite is non-embed CRUD only — no sqlite-vec embed. (Sharpens ticket 04.)
- Reuse: knowledge-card (zk_*), obsidian (vault), hermes-memory (section-md + backend-ab), file2md (extractPdfText via mupdf). SurrealDB v3.2.3 @127.0.0.1:8000. lm-studio hosts embed + vision (google/gemma-4-12b-qat, user-evaluated; confirm id at impl time).
- Platform: Apple Silicon MPS, bfloat16 native, MLX stack (per CLAUDE.md).
- Test corpus: image path TBD; .planning path = this repo's own .planning/.
- **Cross-effort sequencing & flagged risks (2026-08-12 self-reflection):** (1) ticket 13 (memory-card migration) should FOLLOW the hermes-arch convergence moves — codec unification (C1) + Card-abstraction finish (C5) + dedup-into-contract (C6) in `.planning/2026-08-10-hermes-architecture-deepening`; sequencing them first keeps 13 mechanical. (2) New ticket 16 validates SurrealDB HNSW p95 at scale before the full ticket-14 build (newer 2026-08-07 RTT data; respects Decision 04). (3) The 3-tier md↔DB drift policy behind closed 05 is still UNIMPLEMENTED — the Tier-1 re-index hook at `walk-and-ingest.ts:82` is inert; do NOT reuse `merge-plan.ts` as the resolver (it is an LLM consolidation merge — only its hash primitives carry over).

### Absorbed efforts (folded in 2026-08-08)
- 2026-08-08-pi-agent-ext-knowledge-card-obsidian-surealdb-or — foundation; tickets 01-05 migrated here as 01-05. SUPERSEDED.
- 2026-08-08-let-s-continue-our-previous-goal-pi-agent-ext-kn — delta (images + wayfind self-CRUD); tickets migrated here as 06-10. ABSORBED (dir removed).
- 2026-07-30-file2md-for-pdf-... — PDF extractor (mupdf+VLM hybrid VERDICTED; feeds ticket 02). Live prototype ticket 04 stays there. ABSORBED.
- 2026-07-28-hermes-surrealdb-graph-search — graph-augmented recall via RELATE edges, SHIPPED (feat/hermes-surrealdb-graph-search, 758 tests green). Prior art for tickets 03/10. ABSORBED.
- 2026-07-29-brainstorm-to-improve-pi-agent-ext-hermes-memory — embed/backend decisions (ChromaDB rejected; sqlite-vec/SurrealDB-for-graph). Drift tickets closed citing ticket 04. ABSORBED.
- 11 (closed) → task 12: scaffold @repo/pi-agent-ext-core-interface (KnowledgePipeline + publishSeam/readSeam + SEAM_KEYS registry); blocks 06's typed impl. **SHIPPED — PR #1131** (squash `3793a390`): 8-key `SEAM_KEYS` + `SEAM_KEY_ENTRIES` + `publishSeam`/`readSeam` (compile-time orphan prevention); zk publishes `__piKnowledgePipeline`, hermes consumes defensively; repo `seam-contract.test.ts` migrated to `SEAM_KEY_ENTRIES`. Build-track follow-ons: embed index (surreal primary + sqlite-vec fallback), obsidian vault-mind migration, A/B bench vector extension.
- 05 (closed) → task 13: migrate memory-cards into the unified store at graduation (blocked by 06). Migration is mechanical (01's pluggable serializer); gate = store built + proven on knowledge-cards first.
- 06 (closed) → impl SPLIT into **06a (card-agnostic store)** [**SHIPPED #1141**, squash `61e6019a`; spec+plan PR #1137] + **06b (spine orchestrator)** [**SHIPPED #1146**, squash `3bd0d694`; spec+plan PR #1143]. 06a generalizes `MemoryStore` → `Card{kind}` + pluggable serializer (memory+knowledge) + pluggable dedup strategy; knowledge corpus round-trips SQLite; zk unchanged. 06b implements `walkAndIngest` (walk + family-detect + ingest + NEW `healGraph` seam leaf + DB-mirror via card-store + Tier-1 drift stub) + `knowledge_search` tool; 4 grilled decisions pinned (leaf-only orchestration, hermes-owns-walk, knowledge_search tool, DB-mirror-only writes). Embed (04) / full drift (05) / migration (13) OUT of 06b.

## Decisions so far
- 01: unified Card {id, kind, content, frontmatter, embed?, graph?}; hermes store kind-agnostic via pluggable serializer; dedup = single store call-site behind pluggable strategy. CLOSED.
- 02: extractors — md/txt native; pdf=mupdf via file2md (hybrid mupdf-body+VLM-figures, per file2md verdict); docx=mammoth; pptx=pptxtojson; one card per section/page/slide (~512 tok); provenance frontmatter. CLOSED.
- 03: two-layer knowledge graph — wiki-link layer formalized as-is (shared-tag scoreOverlap, no expansion); typed entity-relation layer = md frontmatter source-of-truth (`relations:`) + derived DB index; hybrid relation schema (fixed core + free-form); LLM typed-relation extraction OPT-IN (default off, `kg.llm`/`PI_KG_LLM`). Fork 4 collapsed into carry-over. CLOSED.
- 04: embed backend — model = `text-embedding-nomic-embed-text-v1.5` (768-dim) via LM Studio (zk's existing default, standardized); CONSOLIDATE now (new nomic index serves card-store + obsidian; deprecate vault-mind/ChromaDB `:8000`); touchpoints = ingest card-embed (stored) + query embed; vector store = embed rides backend-ab, SurrealDB native PRIMARY, sqlite-vec FALLBACK. Carry-over "SurrealDB-only" corrected. UNBLOCKS task 12. CLOSED.
  (ROUND-2 2026-08-09: sqlite-vec FALLBACK dropped — not loadable in Bun; SurrealDB HNSW is the primary/only vector store, verified v3.2.3 ~13ms p95 @1k vecs; SQLite fallback = non-vector CRUD/FTS only.)
  (ROUND-2 2026-08-09, Fork B): embed index built LAZILY (not eager-at-ingest) + background backfill (session-backfill.ts pattern) warming SurrealDB HNSW; delta-keyed (per-card hash + model ver); dedup-at-ingest stays FTS/hash; SurrealDB-down falls back to zk JSON-cache cosine. Supersedes 04 Fork B's eager-at-ingest.)
  (ROUND-2 2026-08-09, model): nomic CONFIRMED (768-dim, no migration); under lazy+backfill the model is runtime-swappable (delta-keyed by model ver) -> bge-m3 (recall@1 0.909 vs 0.864) is the documented upgrade if real-workload recall < target. qwen3 dominated by bge-m3.)
- 05: migration = MIGRATE AT GRADUATION (memory-cards coexist during build, migrate in as the final milestone; tracked → task 13); DB↔md drift = FIELD-CLASSIFICATION policy — Tier 1 md-canonical (md wins, re-index), Tier 2 derived cache (regenerate, no write-back), Tier 3 DB-authoritative opt-in (no md write-through; the worth-scoring precedent), merge-plan only for genuine md↔db content conflicts (reuse hermes `merge-plan.ts` hash/optimistic-concurrency primitives). CLOSED.
- Hermes-as-spine (revise 01): hermes owns pipeline orchestration + store; zk = graph/ingest/RAG primitives provider. -> ticket 06
- 11: core-interface package contract pinned — @repo/pi-agent-ext-core-interface hosts typed interfaces + SEAM_KEYS (single source of truth) + publishSeam/readSeam accessors (compile-time orphan prevention); lockstep pi-core; incremental migration (KnowledgePipeline first). CLOSED. Impl → task 12.
- Image input: BOTH OCR + vision-LLM (google/gemma-4-12b-qat via lm-studio), one merged card. -> ticket 07
- Wayfind card granularity: per-ticket (tickets/NN.md = card kind=planning-ticket; map.md = index). -> ticket 08
- Staleness: source-dependency graph (deps declared; re-validate on change). -> ticket 10
- Carry-over (feeds 04): embed = SurrealDB-only (+ lm-studio); SQLite non-embed CRUD only.
  (SUPERSEDED by 04 — see Decisions: embed rides backend-ab; SurrealDB primary, sqlite-vec fallback.)
- 08: [Planning-card model](tickets/08-planning-card-model.md) — Hermes owns ingest+store (planning-card serializer plugs in); wayfind is the CRUD/query client. map.md→effort index card, each ticket→planning-ticket card (decisions inline); same SurrealDB/SQLite as knowledge-cards, namespaced; conflicts = closed tickets sharing scope with divergent resolution-gist. **SHIPPED via PR #1208 (squash 02976974), 2026-08-10**.
- 09: [Planning sync policy](tickets/09-planning-sync-policy.md) — .planning is git-canonical; DB mirrors it on-demand (content-hash staleness) + background backfill; git resolves multi-worktree merges (DB re-mirrors, conflict markers flagged); .planning is a Tier-1 instance of ticket 05's 3-tier drift (md wins). **SHIPPED 2026-08-10** (HEAD `9b459077`; PR self-references on squash-merge).
- [10: Staleness dependency graph](tickets/10-staleness-dependency-graph.md) — v1 auto-infers blocked-by + cited-source-path deps (optional explicit depends_on); re-validate on-access via content-hash + background sweep; stale decisions get a `stale:` flag, block effort graduation, agent re-grills to resolve.
- Next grill order: **04-BUILD** (DB-native embed index — current session decision; SurrealDB primary + sqlite-vec fallback, per Decision 04). Spine [12 + 06a + 06b] shipped; **08 shipped; 09 shipped**; 07/10/13 remain unblocked but not picked. **Next build ticket is 10-impl (staleness dependency graph — closes Phase-2) — plan written `plans/2026-08-10-staleness-dependency-graph.md` (9 tasks; EXECUTE/SDD stage next)**. One per session. (05 closed — migrate-at-graduation + 3-tier drift policy → task 13; spine milestone done — see top of map.)

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
