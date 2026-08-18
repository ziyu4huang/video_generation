---
status: done
blocking: [03]
---
# 01 — Wire augmentEmbedText into hermes backfill
Spec: D2 + D3. Anchors: hermes-memory src/handlers/vector-backfill.ts:98 (`cardEmbedText` — title+tags+body, 1000-char cap, used at :136; index-side only, embedQuery untouched per semantic-search.ts:314), zk entity-summary.ts:165 (`augmentEmbedText(base, summary?)` — pure), hermes constants.ts:90 (`modelVersion` lineage tag).
## Work (amended 2026-08-18 — dep-guard correction)
Original premise "hermes imports FROM zk" was WRONG: hermes has no zk dependency and bun-apps/tests/dep-guard.test.ts (ADR-monorepo-0001, invariant #4, no allowlist) forbids adding that static edge. Seam-mediated route instead:
1. zk publishes the entity-summary capability (summarizeEntity + persisted cache `.knowledge-semantic/entity-summaries-<modelSlug>.json` + augmentEmbedText) through the existing `__piKnowledgePipeline` seam (pi-agent-core-interface/src/interfaces/knowledge-pipeline.ts — SEAM_KEYS/publishSeam/readSeam, same pattern as the embedding-leaf hoist #1586).
2. hermes `cardEmbedText` (vector-backfill.ts:98) reads the capability defensively from the seam (absent → raw text unchanged) and wraps the body via augmentEmbedText(base, summary). Keep cardEmbedText pure/testable (summary source injectable, seam-backed default).
3. Bump `DEFAULT_EMBED_MODEL_VERSION` (hermes constants.ts:90, `"nomic-embed-text-v1.5"` → `"nomic-embed-text-v1.5+es1"`): SurrealDB ids `${mdId}__${modelVersion}` + delta check (vector-backfill.ts:200) then re-embed existing cards naturally. NO bespoke migration.
4. Query side untouched (embedQuery, semantic-search.ts:314).
## Acceptance
- A/B sanity test: fixture cards with entity summaries → augmented embed text differs from raw; empty summary → unchanged (mirrors augmentEmbedText contract).
- Re-embed on modelVersion bump covered by/consistent with existing delta tests.
- hermes + zk package tests green; hermes schema-cost pin ≤2100 tok unchanged (run the schema-cost canary).
- dep-guard test green (no new static package edges).

## Resolution
- Seam leaf `entityAugment` added to `KnowledgePipeline` (pi-agent-core-interface): zk publishes the entity-summary capability (summarizeEntity + persisted cache + augmentEmbedText) via `publishSeam`; hermes `cardEmbedText` reads it defensively (absent → raw text unchanged, same posture as resolveCards).
- Card embed text augmented per the augmentEmbedText contract; A/B tested (fixture cards with entity summaries → augmented embed text differs from raw; empty summary → unchanged).
- `DEFAULT_EMBED_MODEL_VERSION` bumped `nomic-embed-text-v1.5` → `nomic-embed-text-v1.5+es1`: SurrealDB ids `${mdId}__${modelVersion}` + delta check re-embed existing cards naturally; no bespoke migration.
- Query side untouched (embedQuery / semantic-search.ts).
- Suites: hermes 1625/0 + zk + core-interface green.
