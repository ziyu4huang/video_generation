# Read-only recon — knowledge-extract pipeline & LeanRAG (2026-08-18)

Status: token budget hit mid-run. Items marked `[UNVERIFIED]` were not fully read.

## (a) Relevant .planning efforts + status

Top-level entries: 33 effort dirs (2026-07-31 … 2026-08-17), plus `done/`, `specs/`, `plans/`, `knowledge/`, `recon/`, `audit/`, REVIEW-*.md files.

### 1. `2026-08-08-knowledge-pipeline` — status: `active` (map.md frontmatter), but ticket log says "100% dispositioned"
- Goal: unified card-agnostic pipeline: memory/files → knowledge-cards (git-canonical md) → two-layer graph → DB CRUD (SurrealDB embed / SQLite non-embed) → obsidian vault. Hermes = orchestrator+store; zk (knowledge-card) = graph/ingest/RAG primitives.
- DONE (per map.md build log): spine (tickets 12/06a/06b, PRs #1131/#1141/#1146); 08 (#1208), 09, 10 (#1242), 14 HNSW (#1242 era), 15-Phase1 (#1168), 19 LeanRAG dedup-first (#1282), 03 Phase-1 + Phase-2 (LLM relation extractor, 2026-08-13/14), 20 freq-vote (2026-08-14 — "LeanRAG selective port ③⑤⑥ complete"), 07 image cards (#1324), 13 memory-card graduation (#1363/#1372/#1378), kp17 waived, kp18 T5b (#1524), kp21 Tier-1 (#1494) — "Knowledge-pipeline tickets 100% dispositioned".
- OPEN/noted-deferred: augmentEmbedText embed wiring (separate polish); entity scan revisit at >2k cards; 3 ephemeral SQLite opens per warm query; Tier-3 drift waived (not MVP); CLIP image-vector + multi-panel split = fog. Known issue #1130 `__piRateLimitState` orphan seam.
- Sub-dirs: brainstorm/leanrag-knowledge-pipeline-adoption.md, plans/ (19, 20, 03×2, …), sdd/19-leanrag-redundancy-aware-retrieval/ (3 task reports + 3 review diffs — full SDD cycle).

### 2. `2026-08-16-hermes-leanrag-simplify` — status: `complete`; all 11 tickets `status: done`
- Goal: reshape hermes-memory to LeanRAG shape ~80%: ≤~15k LOC, 6 tools w/ hard schema-cost pin, Surreal default + sqlite fallback, 2 repos, 2 dedup mechanisms.
- DONE: 01 baseline … 11 provenance-acceptance all done. D5 CUT: LLM kg extractor path + interview/insights commands.
- GAP noted in map: D2 LOC target unmet (+0.1% — "surface simplification instead"); follow-up seeded → leanrag-hierarchy-port.

### 3. `2026-08-16-leanrag-hierarchy-port` — status: `complete`
- Goal: port LeanRAG ① (semantic-aggregation hierarchy) + ② (LCA tree retrieval) onto the 6-tool base; deterministic greedy cosine agglomerative clustering, per-layer LLM summaries w/ token budget, derived multi-level MOC aggregation cards (T2 derived md), retrieval auto-expands via parent paths.
- DONE: all 8 tickets landed (acceptance.md: zk 473/0, hermes 1620/0, core-interface 26/0, test:adr 19/0; squash SHAs per ticket listed; ADR-hermes-memory-0001 superseded-in-part 3a5ceccc). 5 of 8 ticket files carry `## Resolution` [count checked; 3 files may record resolution differently — UNVERIFIED which].

### 4. `2026-08-17-knowledge-pipeline-polish` — status: `complete`
- Goal: 4 zero-behavior-change levers — L1 CLI retirement, L2 leaf hoist, L3 trivia removal, L4 docs truth (censuses from done/2026-08-17-knowledge-pipeline-simplify).
- DONE: ticket 05 acceptance = "4/4 structure targets MET; gates green; effort complete."

### 5. `2026-08-10-hermes-architecture-deepening` — architecture/lessons + 13 tickets (codec unification, card abstraction, dedup contract, sqlite backend split, knowledge-card megafile split…). C1/C5/C6 landed (#1196/#1343/#1346/#1349) as prerequisites for ticket-13 graduation. `[ticket-level status not re-read]`

Related closed efforts in `.planning/done/`: 2026-07-28-hermes-surrealdb-graph-search, 2026-07-29-brainstorm-to-improve-pi-agent-ext-hermes-memory, 2026-08-08-pi-agent-ext-knowledge-card-obsidian-surealdb-or, 2026-08-12-unified-merge-all-existing-unfinished-knowledge, 2026-08-17-knowledge-pipeline-simplify.

## (b) LeanRAG feature location + state

**Packages:**
- `bun-apps/pi-agent-ext-hermes-memory/` — orchestrator/spine: `src/walk-and-ingest.ts`, `src/tools/knowledge-search-tool.ts`, `src/composition/tools.ts`, `src/store/semantic-search.ts`, `src/store/surreal/{schema,vector-store}.ts`, `src/store/relation-schema.ts`, `src/handlers/hierarchy-build.ts`, `src/types.ts`, `src/constants.ts`. Tests: `tests/store/semantic-search.test.ts`.
- `bun-apps/pi-agent-ext-knowledge-card/` (zk) — primitives: `src/{extractor,hierarchy,hierarchy-build,entity-summary,retrieve,aggregation-write,zk-task-config,types}.ts`; tests `__tests__/{hierarchy,retrieve-tree,extractor,llm-extractor}.test.ts` (llm-extractor test retained even though LLM kg path was CUT per simplify D5 — check it tests fallback `[UNVERIFIED]`).
- `bun-apps/pi-agent-core-interface/` — seam: `src/interfaces/knowledge-pipeline.ts`, `src/entities.ts`, `src/embedding-leaf.ts` + `src/__tests__/embedding-leaf.test.ts`.

**Docs:** `pi-agent-ext-hermes-memory/docs/LEANRAG-PROVENANCE.md` (upstream LeanRAG provenance ①–⑥ mapping), `docs/adr/0001-leanrag-selective-port.md` (selective-port decision: ③ first, ①② deferred→later shipped via hierarchy-port, ⑤⑥ in ticket 03), `bun-apps/docs/adr/0001-strict-downward-edges-knowledge-layer.md`, `bun-apps/docs/adr/INDEX.md`.

**Completion state (from planning + tests):** selective port ③⑤⑥ complete (tickets 19+20, #1282); hierarchy ①② complete (hierarchy-port effort); retrieval tree expansion + budget/config + docs provenance shipped; simplify + polish efforts closed green. LeanRAG circled-numbers ①–⑥ all dispositioned.

**Gaps / open markers (from map notes):** augmentEmbedText embed wiring deferred; entity-scan scale trigger >2k cards; CLIP image embed + multi-panel split fog; Tier-3 DB-authoritative drift waived; CLI retired in polish (L1) — so no standalone CLI now; GUI presence `[UNVERIFIED — grep aborted]`; explicit TODO scan `[UNVERIFIED — grep aborted]`.

## (c) Key file paths

- `.planning/2026-08-08-knowledge-pipeline/map.md` (canonical build log)
- `.planning/2026-08-08-knowledge-pipeline/{brainstorm,plans,sdd}/…` (LeanRAG tickets 19/20)
- `.planning/2026-08-16-hermes-leanrag-simplify/` (acceptance.md, spec.md, 11 tickets)
- `.planning/2026-08-16-leanrag-hierarchy-port/` (acceptance.md green; 8 tickets)
- `.planning/2026-08-17-knowledge-pipeline-polish/` (spec locked, acceptance closed)
- `bun-apps/pi-agent-core-interface/src/embedding-leaf.ts` (+ `src/__tests__/embedding-leaf.test.ts`, `src/interfaces/knowledge-pipeline.ts`)
- `bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts`, `src/store/semantic-search.ts`, `src/tools/knowledge-search-tool.ts`, `src/handlers/hierarchy-build.ts`
- `bun-apps/pi-agent-ext-knowledge-card/src/{extractor,hierarchy-build,retrieve,entity-summary}.ts`
- `bun-apps/pi-agent-ext-hermes-memory/docs/LEANRAG-PROVENANCE.md`, `docs/adr/0001-leanrag-selective-port.md`

## embedding-leaf end-to-end summary — `[INCOMPLETE: read of embedding-leaf.ts aborted by budget]`

Known from surrounding evidence only: `embedding-leaf` is the embed lazy-leaf of the `KnowledgePipeline` seam (SEAM_KEYS, publishSeam/readSeam, core-interface pkg PR #1131); embed = LM Studio `text-embedding-nomic-embed-text-v1.5` 768-dim, SurrealDB `card_vectors` HNSW lazy+delta-keyed backfill, cosine JSON-cache fallback (T5a/T5b); query+ingest embeds, dedup-first retrieval w/ freq-vote. Entry points: walk-and-ingest (ingest side), knowledge_search tool / searchSemantic (query side), healGraph seam leaf. **Next session: read embedding-leaf.ts + interfaces/knowledge-pipeline.ts directly, grep TODO/FIXME, check GUI wiring.**
