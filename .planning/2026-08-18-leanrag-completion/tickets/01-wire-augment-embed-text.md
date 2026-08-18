---
status: open
blocking: [03]
---
# 01 — Wire augmentEmbedText into hermes backfill
Spec: D2 + D3. Anchors: hermes-memory src/handlers/vector-backfill.ts:98 (`cardEmbedText` — title+tags+body, 1000-char cap, used at :136; index-side only, embedQuery untouched per semantic-search.ts:314), zk entity-summary.ts:165 (`augmentEmbedText(base, summary?)` — pure), hermes constants.ts:90 (`modelVersion` lineage tag).
## Work
1. In hermes backfill, derive per-card entity summary via zk primitives (`summarizeEntity` with caller-owned cache + persisted `.knowledge-semantic/entity-summaries-<modelSlug>.json`) and wrap the body through `augmentEmbedText` inside `cardEmbedText`. Respect zk's no-store/no-LLM-import constraint (D4): hermes imports FROM zk only.
2. Bump `modelVersion` (constants.ts:90) so existing SurrealDB `card_vectors` ids (`${mdId}__${modelVersion}`) + delta check (vector-backfill.ts:200) naturally re-embed the vault — no bespoke migration.
## Acceptance
- A/B sanity test: fixture cards with entity summaries → augmented embed text differs from raw; empty summary → unchanged (mirrors augmentEmbedText contract).
- Re-embed on modelVersion bump covered by/consistent with existing delta tests.
- hermes + zk package tests green; hermes schema-cost pin ≤2100 tok unchanged (run the schema-cost canary).
