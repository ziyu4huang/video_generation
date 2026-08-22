# 03 — hermes folds to a capture-only journal

- **Phase:** P0 · **Package:** `s2-agent-ext-hermes-memory` · **Status:** closed 2026-08-22 · **Breaking (D0/D1) · RISKY (largest deletion)**

## Problem

Hermes recall is measured-dead (2026-08-19 audit: hit@1/3/5 0/20, MRR 0.000 — vectors DB
never created, lexical fallback returns zero rows for natural-language queries). The
semantic search surface costs 6-tool schema for zero recall, and re-arming it would
duplicate kcard's measured 1.00 blend. D1: fold to capture-only.

## Approach

1. **Pre-census (first step, before deleting):** enumerate every agent-facing tool, handler,
   test, and doc that touches the semantic search surface / vector path. Land the census in
   this ticket's resolution note.
2. Keep: session journal, auto-capture, correction detection, session_shutdown flush,
   `convergeHermesMemory` handoff to kcard (ADR-0001), deterministic exact-match session
   search.
3. Retire: semantic memory-search surface; dead vector path — `store/surreal/vector-store.ts`,
   `store/surreal/vector-store-helpers.ts`, `VECTOR_BOOTSTRAP_SQL`, `handlers/vector-backfill.ts`,
   related config/env surface.
   **Pre-decision (owner-approved 2026-08-22):** SurrealDB stays as the **store of record for
   the capture-only journal** (crud store; PR #753 Phase 3 backend, SurrealQL v3.2.3 traps
   already charted). It never enters the retrieval path — any vector surface in SurrealDB
   would re-arm the exact role D1/D2 just retired and duplicate kcard's measured 1.00 blend.
   Recall routes exclusively through kcard `retrieveRecords`. Future ledger upgrades
   (ticket 09 RecallLedger, ticket 11 usage ledger) start as lightweight derived files;
   SurrealDB is the natural upgrade position if volume ever demands it.
4. Rewrite the hermes ADR that planned the vector path (supersedes; cite D1 + the 0/20
   audit). Recall questions route through `knowledge_query`.
5. Update `bun-apps/s2-agent-ext-knowledge-card` docs that describe hermes recall
   (DEPENDENCIES.md / KNOWLEDGE-LAYER.md seam notes) — kept minimal per docs policy.

## Acceptance

- Hermes tool count reduced; every remaining tool deterministic-testable (no live-model
  dependency in tests).
- `run-test.sh` (hermes canonical gate) green; cross-package typecheck green
  (`s2-agent` cross-package typecheck gate — hermes standalone tsc is broken by design,
  see memory).
- ADR rewritten and `bun run test:adr` green.

## Verification

Canonical hermes gates + `bun run test:adr` + ticket 04's committed audit run as the
after-proof (hermes-journal questions answered via kcard retrieval).

## Resolution

**Pre-census (2026-08-22, post-PR-#1817):** grep `vector|semantic|card_vectors` across
`s2-agent-ext-hermes-memory`:

- **Delete whole-file (dead vector path / semantic wiring):**
  `src/store/surreal/vector-store.ts` (VectorStore + createVectorStore),
  `src/store/surreal/vector-store-helpers.ts`,
  `src/store/semantic-search.ts` (searchSemantic/SemanticRelation),
  `src/store/card-vectors-cache.ts`,
  `src/handlers/vector-backfill.ts` + `src/handlers/vector-backfill.test.ts`,
  `src/composition/knowledge-semantic.ts` (buildKnowledgeSemanticOpts — THE wiring that
  was never armed: `vectors` DB never created because it gates on `config.surreal.endpoint`
  and lazily on `semantic:true`, which the audit showed returns zero rows).
- **Surgery (remove the semantic opt-in surface, keep the tool lexical-only):**
  `src/tools/knowledge-search-tool.ts` (semantic param + semanticOpts + warm-HNSW re-rank
  block; keep lexical/tags path + the `buildGraphRelationsFetcher`/`buildLexicalRecall`/
  `buildEntityRecall` exports only if still referenced after knowledge-semantic.ts dies),
  `src/composition/tools.ts` (buildKnowledgeSemanticOpts import + wiring),
  `src/config.ts` (vectorTopK/vectorEf parsing),
  `src/constants.ts` (Vector/semantic-search block, DEFAULT_VECTOR_TOP_K/EF),
  `src/types.ts` (embedModel/embedModelTag/vectorTopK/vectorEf/semanticSurvivingK fields),
  `src/store/surreal/schema.ts` (VECTOR_BOOTSTRAP_SQL + card_vectors bootstrap),
  `src/store/surreal/surreal-backend.ts` / `surreal-client.ts` / `per-user-db.ts` (vector
  DB plumbing only — CRUD journal store stays, pre-decision above).
- **Incidental mentions (comment-word only, leave or reword opportunistically):**
  `memory-store.ts:1027`, `merge-plan.ts` ("semantic constraints"), `grill-decision-tool.ts:98`,
  `auto-consolidate.ts`, `memory-dedup.ts:18`, `repository.ts:88`, `constants.ts:394`.
- **Docs:** CONTEXT.md / PRD.md / README.md / REJECTED.md vector/semantic sections;
  `docs/adr/0001-leanrag-selective-port.md` rewrite (step 4).
- **Tests touching the surface:** `card-store.test.ts`, `image-card-ingest.test.ts`
  (vector refs), plus the deleted `vector-backfill.test.ts`.

**Outcome (2026-08-22):** landed as `refactor(hermes)!` + ADR docs commits on
`feat/kcard-03-hermes-fold`. Final: −4,142 net lines / 24 files in the surgery commit.

- Deleted exactly the census list (7 src files + their tests: `vector-store`,
  `vector-store-helpers`, `semantic-search`, `card-vectors-cache`, `vector-backfill`(+test),
  `knowledge-semantic`, plus `tests/store/semantic-search.test.ts`,
  `tests/store/surreal/vector-store.test.ts`, `tests/walk-and-ingest-vector-backfill.test.ts`).
- `knowledge_search` is lexical/tags-only: 263 → 186 tok (its `semantic` param + HNSW
  re-rank + ticket-20 vote builders removed). Hierarchy embedder now pins
  `SEMANTIC_MODEL_DEFAULT` (D3) instead of the removed `config.embedModel`.
- SurrealDB CRUD journal store untouched (pre-decision honored); only vector plumbing
  (`VECTOR_BOOTSTRAP_SQL`, per-user `vectors` DB) removed from the surreal layer.
- ADR: new `docs/adr/0002-capture-only-journal.md` (ADR-hermes-memory-0002) supersedes the
  vector-half of ADR-0001, citing D1 + the 0/20 audit; INDEX.md updated; ADR-0001
  back-linked. CONTEXT/PRD/README/REJECTED/KNOWLEDGE-LAYER vector sections retired.
- kcard seam: `knowledge-pipeline-seam.ts` comment updated (its `entityAugment` consumer
  was the retired vector-backfill).
- **Gates (all on the final tree):** hermes `bun run test` 1539 pass / 0 fail · hermes
  `run-test.sh` ✓ · s2-agent cross-package typecheck exit 0 · `bun run test:adr` 19 pass.
- **Schema cost (D0 baseline regen):** `knowledge_search` 208 → 171 tok; root baseline
  refreshed to 22,529 tok / 74 tools via the canonical regen command — the +294 vs the
  ticket-02 baseline is #1818's `send_message` (landed between the two baselines), not
  this change; this change is net-negative on hermes rows.
- DoD grep (`card_vectors|VectorStore|vectorTopK|semanticOpts|VECTOR_BOOTSTRAP_SQL|
  searchSemantic|vector-backfill`) → zero code hits; remaining matches are historical
  comments citing the retirement + ADR-0002.
- Implementation dispatch: implementer fork died on a 429 usage limit mid-wrap-up
  (docs uncommitted); parent session finished the docs commit, re-ran every gate
  independently, and cherry-picked both commits onto the PR branch.
