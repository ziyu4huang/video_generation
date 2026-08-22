# 13 — ExtractLoop dedup: vector pre-filter + gray-zone LLM decision

- **Phase:** P3 · **Package:** `s2-agent-ext-knowledge-card` · **Status:** open

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
