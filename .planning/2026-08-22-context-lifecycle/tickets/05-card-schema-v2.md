# 05 — card schema v2: summary L0 + experience kind + merge-op table

- **Phase:** P1 · **Package:** `s2-agent-ext-knowledge-card` · **Status:** open · **Breaking (D0/D4)**

## Problem

Cards have no L0 abstract (retrieval digests re-derive from bodies), no first-class
"experience" shape (OpenViking's Situation/Approach/Reflect with supersedes lineage), and
merge semantics are implicit in code paths (wiki-merge, supersede) rather than a typed
per-field op table. D4 defines schema v2.

## Approach

1. `src/card-format.ts`: add `summary` (≤256 chars, optional until backfill makes it
   near-universal); add `experience` to the record/card `type` enum; add the merge-op table
   — `id`/`created` immutable, `summary` replace, counter-like fields sum,
   `sources`/`entities`/`tags` patch-union — as data consumed by `src/wiki-match.ts` and
   (later, ticket 13) the ExtractLoop merge path.
2. `src/card-render.ts` + `src/task-builders.ts`: SAR body template for the `experience`
   kind (`## 情境 / 做法 / 反思` sections); distiller may emit it; `supersedes` lineage
   reuses `src/supersede.ts` unchanged.
3. `summary` writing at ingest: deterministic first-sentence via `src/extractor.ts`;
   LLM condense (`src/llm-chat.ts`) only when the body exceeds the budget — leanrag-D6
   budget-gating pattern; never blocks ingest (best-effort, blank on failure).
4. One-shot backfill `scripts/backfill-summaries.mjs` (D0 migration): stamp `summary:` on
   existing active cards; idempotent; measure the re-embed burst the backfill triggers
   (mtime fingerprints) and record it.

## Acceptance

- Format/render/adapters tests updated + green; new tests: merge-op table semantics, SAR
  render, summary budget gate (LLM called only over budget — counter in test).
- Backfill covers 100% of active cards in the real convergence folder (receipt count);
  re-ingest of the same records is byte-stable except `summary` (idempotency note in test).
- `graphHealth` clean post-backfill; `bun test __tests__/` green.

## Verification

Canonical kcard gates + `zk-query --health` on the real vault post-backfill + eval hit@4
unchanged (ticket 15 harness or existing eval set — summary must not change ranking).
