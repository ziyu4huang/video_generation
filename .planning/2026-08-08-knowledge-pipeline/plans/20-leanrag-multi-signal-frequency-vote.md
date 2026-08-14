# Plan — ticket 20: LeanRAG multi-signal frequency-vote + boostWeight

- **Ticket:** `tickets/20-leanrag-multi-signal-frequency-vote.md` (blocked-by 03/19 — both SHIPPED)
- **Spec/ADR:** `bun-apps/pi-agent-ext-hermes-memory/docs/adr/0001-leanrag-selective-port.md` (concept ③ vote half); ticket-19's deferred-knob comments
- **Scope:** Frequency-vote across ≥2 independent recall signals on the WARM path of hermes `searchSemantic` — HNSW + knowledge-lexical (SQLite FTS membership) + entity-recall (query-side dictionary extraction × graph.entities scan) — with re-rank by signal count and a `boostWeight` 4-point config knob. Fallback paths unchanged (single-signal).

## Context

Ticket 19 shipped redundancy-aware retrieval (contentHash dedup + survivingK); its code comment defers boostWeight here. Ticket 03 shipped the entity substrate (graph.entities persisted, dense — dictionary ingest always emits; relations sparse — kg.llm default OFF). Research findings that pin the design: (1) per-signal scores are mutually incomparable (HNSW cosine vs zk integer blends vs FTS which returns NO relevance — recency-ordered) → the vote is rank/membership-based, never cross-signal score arithmetic; (2) `memory_fts` is external-content FTS over the whole `memories` table — kind-agnostic, covers knowledge cards; (3) `extractEntities` (zk, deterministic, pure) runs on query strings — and hermes→zk is the SANCTIONED dependency direction (hermes is the spine; kp already injected); (4) the single production caller (knowledge-search-tool) maps warm hits onto zk cards by mdId — ordering-only changes need no agent-facing fields; (5) vote home = inside `searchSemantic` warm path, BEFORE the existing dedup+cap tail (never-throws + dedup invariants preserved on all paths).

Note: hermes consumes zk today only via the runtime `readSeam("__piKnowledgePipeline")` (knowledge-pipeline-seam.ts) — no static workspace dep. Task 3 adds it (or falls back per its NOTE).

## Global Constraints

- **Rank/membership-based vote only** — no cross-signal score arithmetic. Per-signal rank normalized to (0,1]: `1 - (rank_i / (topK + 1))`.
- **boostWeight formula (PINNED):** `final = (signalCount - 1) * boostWeight + bestRankScore`. Additive bonus; at default 1.0 a 2-signal card with any rank outranks a 1-signal card (rank score ≤ 1), satisfying the acceptance criterion; the knob tunes dominance. 4-point registration (constants → types → DEFAULT_CONFIG → loadConfig allowlist, `> 0` floor guard), default 1.0, mirroring `survivingK`.
- **Warm path only** — knowledgeFallback/memoryFallback stay single-signal, unchanged.
- **Vote sits before `dedupByRelation(dedupByContentHash(...))` + survivingK cap** — dedup keeps FIRST hit, so vote ordering determines the survivor.
- **Injectable seams** (fetchRelations pattern): signals injected as options; tests use canned providers; production builders in knowledge-search-tool/index wiring; silent-skip everywhere — a failing/empty signal NEVER breaks search (never-throws preserved).
- **No new agent-facing fields required** — optional `signalCount?: number` on `SemanticSearchHit` for observability; the tool's returned card list order changes only.
- **augmentEmbedText wiring is EXPLICITLY OUT OF SCOPE** (deferred from P2-T4's note — separate polish ticket; avoids scope drift).
- **Test style:** hermes `bun run check` (tsc) + `tests/`+`__tests__/` bun:test, mocked providers (fakeEmbedder/fakeVectorStore pattern from ticket-19 tests).

## File Structure

**Create:** none (all modifications — vote logic lives in semantic-search.ts; builders in the existing tool file).

**Modify:**
- `bun-apps/pi-agent-ext-hermes-memory/src/store/semantic-search.ts` — vote + seams + signalCount.
- `bun-apps/pi-agent-ext-hermes-memory/src/{constants,types,config}.ts` — boostWeight 4-point.
- `bun-apps/pi-agent-ext-hermes-memory/src/tools/knowledge-search-tool.ts` — production builders (FTS lexical + entity recall) + wiring.
- `bun-apps/pi-agent-ext-hermes-memory/src/index.ts` — pass builders + boostWeight.
- `bun-apps/pi-agent-ext-hermes-memory/tests/store/semantic-search.test.ts` + `__tests__/knowledge-search-tool.test.ts` — vote/config coverage.
- `bun-apps/pi-agent-ext-knowledge-card/src/entities.ts` — export `normEntity` (module-private today at entities.ts:181; needed for consistent name normalization) — one-line export change.

---

### Task 1 — Vote core + seams (semantic-search.ts)
Goal: pure vote/rank machinery + injectable signal seams.
- `SearchSemanticOptions` gains `lexicalRecall?: (queryText: string, topK: number) => Promise<Array<{ mdId: string; rank: number }>>` and `entityRecall?: (queryText: string, topK: number) => Promise<Array<{ mdId: string; rank: number }>>` (rank = 0-based position in that signal's own list).
- `SemanticSearchHit` gains `signalCount?: number` (set post-vote; hits on fallback paths never get it).
- Private pure `voteAndRank(hits, signals: Array<Map<string, number>>, boostWeight, topK)`: for each hit compute `bestRankScore = max over signals containing mdId of (1 - rank/(topK+1))`; `final = (signalCount - 1) * boostWeight + bestRankScore`; sort desc by final, tie-break original warm order (stable). signalCount = 1 + number of extra signals containing the mdId. Never throws; empty/undefined signals → signalCount 1, plain warm order preserved.
- Warm path wiring: after the knn rank loop, if either seam present, `await Promise.allSettled([lexicalRecall?, entityRecall?])` (allSettled — a rejected signal is skipped), build signal maps, vote, THEN the existing fetchRelations + dedup + cap tail (unchanged order of operations after the vote).
- TDD (extend `tests/store/semantic-search.test.ts`, fakeEmbedder/fakeVectorStore pattern): (a) 2-signal card outranks 1-signal with comparable ranks (assert order + signalCount); (b) both signals empty → warm order unchanged, signalCount=1 set whenever seams are present (simpler, assert it); (c) one signal rejects (allSettled) → vote proceeds with the other; (d) boostWeight 0.1 vs 10 changes dominance (a weak 2-signal vs strong 1-signal flips); (e) dedup still keeps the FIRST (highest-voted) hit; (f) fallback paths unchanged (no seams consulted).
- Verify: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test tests/store/semantic-search.test.ts )`.

### Task 2 — boostWeight 4-point config
Goal: registered knob.
- `constants.ts`: `DEFAULT_BOOST_WEIGHT = 1.0`; `types.ts`: `MemoryConfig.boostWeight: number`; `config.ts`: DEFAULT_CONFIG + loadConfig allowlist (finite number > 0 floor guard — mirror survivingK's numeric guard at config.ts:379-381).
- Thread: index.ts knowledge-search wiring passes `boostWeight: config.boostWeight` into the searchSemantic call (alongside fetchRelations).
- TDD (extend `tests/config.test.ts`): default 1.0; override; invalid (0, -1, "x", NaN) rejected → default.
- Verify: hermes check + config test + full suite once.

### Task 3 — Production signal builders (knowledge-search-tool + zk export)
Goal: real lexical + entity signals over SQLite.
- zk `entities.ts`: export `normEntity` (module-private at entities.ts:181 — verify name at impl time; one-line export).
- hermes `knowledge-search-tool.ts`: `buildLexicalRecall(memoryDir)` — ephemeral SqliteBackend (the buildGraphRelationsFetcher pattern at knowledge-search-tool.ts:67), FTS subquery `SELECT m.md_id FROM memories m WHERE m.id IN (SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?) AND m.target='knowledge' AND m.md_id IS NOT NULL LIMIT ?` with `normalizeFts5Query(queryText)` (store/sqlite/fts-query.ts) + fallback to plain-quoted on FTS error; rank = row order (membership-recency; acceptable — membership is what votes). Silent-skip on any error (return []).
- `buildEntityRecall(memoryDir)`: extract query entities via zk `extractEntities(queryText)` (entities.ts:114, deterministic, pure); normalize names via `normEntity`; scan `SELECT md_id, graph FROM memories WHERE target='knowledge' AND graph IS NOT NULL` (rowid-paged batches like the fetchers); match card graph.entities names against the query set; rank by match-count desc then first-seen. Silent-skip everywhere.
- Wire both into index.ts searchSemantic options (alongside fetchRelations).
- zk dep: add `@repo/pi-agent-ext-knowledge-card: workspace:*` to hermes package.json deps (absent today — hermes consumes zk only via the runtime seam; hermes→zk is the sanctioned spine direction; verify bun workspace linking via `bun install` from `bun-apps/`).
- TDD (extend `__tests__/knowledge-search-tool.test.ts`, tmp SQLite DB fixtures — knowledge cards in FTS + graph entities): lexical returns matching mdIds only (target='knowledge' filter; memory cards excluded); entity recall matches by normalized name; malformed graph JSON skipped; both return [] on closed/corrupt DB.
- Verify: hermes check + tool tests + full suite.
- NOTE: if hermes→zk dep addition is problematic at implementation time, fall back to a local minimal extractor (split query into capitalized/backtick tokens) and note it — do NOT invert any dependency.

### Task 4 — Integration + observability polish
Goal: end-to-end warm-path vote over real builders + signalCount surfaced.
- Integration test (mocked embedder/vectorStore + REAL tmp-SQLite builders): a card present in HNSW + FTS + entity-set outranks a HNSW-only card with better cosine rank (assert order + signalCount=3 vs 1).
- The tool's `content.text` card list order follows the voted order (assert).
- map-deferred notes consolidated (see ship).
- Verify: hermes full suite + zk full suite (normEntity export is zk's only touch — zk suite must stay green).

## Out of scope
- `augmentEmbedText` embed-input wiring (separate polish — deferred from P2-T4 note).
- Persistent entity/relation index (existing scale-trigger deferral).
- Vote on cold/fallback paths (single-signal by design).
- LeanRAG ①② aggregation/LCA (fog/future); near-dup cosine collapse (17).
- Relation-based recall (relations sparse while kg.llm defaults OFF).

## Execution handoff
SDD via subagent-driven-development into `.planning/2026-08-08-knowledge-pipeline/sdd/20-leanrag-multi-signal-frequency-vote/`; task order 1→4 (1 blocks 4; 2, 3 independent of each other); gh ship, no --auto. Process learnings: single-package tight tasks; targeted per-task verification; lean read-only reviews; full-suite at whole-branch.
