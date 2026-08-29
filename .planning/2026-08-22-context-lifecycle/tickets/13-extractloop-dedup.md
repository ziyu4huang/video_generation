# 13 — ExtractLoop dedup: vector pre-filter + gray-zone LLM decision

- **Phase:** P3 · **Package:** `s2-agent-ext-knowledge-card` · **Status:** closed 2026-08-30 (PR #2160)

## Problem

Ingest dedup is Jaccard-token only (wiki-aware 0.85 upsert; distill gate 0.72) — semantic
near-duplicates with different wording slip through and mint parallel cards. OpenViking's
ExtractLoop pattern: vector pre-filter of similar existing memories, then an LLM
dedup decision, then typed merges.

## Approach

1. Pre-filter: top-k similar existing cards from the `.knowledge-semantic` cache embeddings
   (BGE-M3 after ticket 01) — cosine ≥ 0.90 top-1 → deterministic merge via the D4
   merge-op table (extends the wiki-aware path in `src/ingest.ts`);
   0.75–0.90 → ONE LLM skip/create/merge decision via `src/llm-chat.ts` (local model,
   temp 0.3, existing retry envelope); < 0.75 → straight create.
2. Gray-zone LLM output is advisory-with-guardrails: `merge` requires naming the surviving
   card id; anything malformed → create (fail-open to today's behavior).
3. Embed-cache misses degrade to today's Jaccard-only path (offline-safe).
4. Tests use the existing `_testEmbedder` seam + a chat mock; deterministic corpus tests:
   seeded near-dups merge, distinct corpus zero false merges, LLM-call counter proves the
   LLM runs only in the gray zone.

## Acceptance

- Seeded-corpus tests: merge precision target hit, zero false merges on distinct corpus,
  gray-zone-only LLM invocations (counter).
- Re-ingest idempotency preserved (same input → same vault state).
- `bun test __tests__/` green; distill pipeline tests (`__tests__/distill/*`) green.

## Verification

Canonical kcard gates + a small real-vault run: re-ingest a known near-dup pair from the
fixtures and show the merge receipt.

## Resolution (2026-08-30, PR #2160)

Shipped as `src/semantic-dedup.ts` + `ingestRecords` wiring behind opt-in
`IngestOptions.semanticDedup` (default OFF, tier rule; env `PI_KG_SEMANTIC_DEDUP=1`).
`wikiMergeIntoCard` gained an `origin` label — semantic merges stamp
`- semantic-merged: <label> (sim=…, date)` provenance (D4 merge-op table, first-wins
id policy unchanged). `IngestSummary` gains `semanticMerged` / `semanticSkipped` /
`dedupDecisions` (the receipt trace). Guardrails as specced: merge must name a candidate
id (sourceId OR basename); unknown target / unparseable-after-retry / HTTP failure all
fail OPEN to create; `skip` drops the record without minting. Exact-id records skip BOTH
pre-filters (normal upsert path). The extract lane is untouched — D14-F3 stands (the
decision layer enforces add_only above ingest; ingest must not merge behind its back),
so the production surface for the flag is the converge/zk_ingest lane.

- Tests: 15 new hermetic (`__tests__/semantic-dedup.test.ts`, `_testEmbedder` +
  `_dedupFetch` seams) — vector-lane merge with the LLM call counter at 0, distinct
  corpus zero false merges, gray-zone-only invocations, guardrails, re-ingest
  idempotency (byte-identical vault state), offline degrade, flag-OFF no-embedder-call.
  Canonical gates: kcard 779 pass / 0 fail, tsc clean; local_ci pass (118s).
- Real-vault receipt (`output/dedup-receipt/RECEIPT.md`): the fixture record
  `pi-ext-dev:extension-is-default-factory…` restated in Traditional Chinese against a
  COPY of the real 2356-card vault, live bge-m3 — cosine 0.867 → gray zone → one LLM
  decision `merge` naming the correct canonical card; `semanticMerged=1, created=0`;
  re-ingest → `unchanged`; distinct control → `below-gray` → created (zero false
  merges). The zh rewording is exactly the case the Jaccard wiki path cannot catch.
