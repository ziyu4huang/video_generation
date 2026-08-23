# Baseline — hermes-leanrag-simplify (ticket 01, 2026-08-16)

## LOC
Total src LOC (non-test .ts): 27173
Top hotspots:

```
   27173 total
    1946 bun-apps/pi-agent-ext-hermes-memory/src/store/memory-store.ts
    1111 bun-apps/pi-agent-ext-hermes-memory/src/store/surreal/surreal-memory-repo.ts
    1090 bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-backend.ts
     969 bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-memory-repo.ts
     852 bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-session-repo.ts
     828 bun-apps/pi-agent-ext-hermes-memory/src/store/skill-store.ts
     807 bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts
     752 bun-apps/pi-agent-ext-hermes-memory/src/index.ts
     745 bun-apps/pi-agent-ext-hermes-memory/src/handlers/skills-command.ts
     677 bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts
     547 bun-apps/pi-agent-ext-hermes-memory/src/store/semantic-search.ts
     535 bun-apps/pi-agent-ext-hermes-memory/src/store/memory-format.ts
     512 bun-apps/pi-agent-ext-hermes-memory/src/tools/memory-tool.ts
     472 bun-apps/pi-agent-ext-hermes-memory/src/store/session-anchor-search.ts
     464 bun-apps/pi-agent-ext-hermes-memory/src/handlers/review-memory-ops.ts
     462 bun-apps/pi-agent-ext-hermes-memory/src/tools/knowledge-search-tool.ts
     450 bun-apps/pi-agent-ext-hermes-memory/src/constants.ts
     434 bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/corruption-recovery.ts
     409 bun-apps/pi-agent-ext-hermes-memory/src/config.ts
     400 bun-apps/pi-agent-ext-hermes-memory/src/handlers/sync-markdown-memories.ts
     386 bun-apps/pi-agent-ext-hermes-memory/src/handlers/skill-rows.ts
     385 bun-apps/pi-agent-ext-hermes-memory/src/types.ts
     375 bun-apps/pi-agent-ext-hermes-memory/src/handlers/auto-consolidate.ts
     350 bun-apps/pi-agent-ext-hermes-memory/src/handlers/correction-detector.ts
```

## Schema cost (10 tools, pre-change)
Measurement: live per-tool run, all 10 hermes-memory tools present, total 3,066 tok:

| Tool | approxTokens | descLen | paramsLen |
|---|---|---|---|
| skill_manage | 578 | 514 | 1797 |
| memory | 410 | 469 | 1171 |
| planning_stale | 369 | 986 | 489 |
| memory_supersede | 347 | 301 | 1087 |
| knowledge_search | 309 | 600 | 635 |
| memory_search | 301 | 549 | 654 |
| grill_decision | 300 | 621 | 578 |
| session_search | 211 | 418 | 424 |
| knowledge_ingest | 189 | 615 | 139 |
| skill_manage_help | 52 | 174 | 33 |
| **total** | **3066** | | |

Live aggregate context: 71 tools / 21,881 tok total (4 builtin + 67 extension); hermes-memory share 3,066 tok. Pinned `scripts/schema-cost-baseline.json` is stale for this purpose (61 tools / 18,810 tok, only 7 of 10 hermes tools, sum 2,199 tok) — live numbers above are authoritative for the baseline.
Invocation used: b1 (`bun test schema-cost` — 17/17 pass, machinery validated) + per-tool numbers via the canonical live CLI it gates: `bun bun-apps/pi-agent/src/cli.ts cli tools-metrics --schema-cost --json` (surface surfaced by `scripts/check-schema-cost.ts`). No install required or performed.

## Feature matrix (27 items, from spec D1-D8)
| # | Feature | Verdict | Ticket | Note |
|---|---|---|---|---|
| 1 | memory CRUD+search | Keep | 02 | unified search keeps mode=memory |
| 2 | session search (backfill index) | Merge | 02 | into unified `search` mode=session |
| 3 | session search (live index) | Merge | 02 | same |
| 4 | supersede lineage | Merge | 03 | action of `memory` tool |
| 5 | background learning (10-turn) | Keep | — | |
| 6 | correction/error detection | Keep | — | |
| 7 | LLM auto-consolidation | Keep | — | |
| 8 | staleness/aging | Keep | — | |
| 9 | planning-stale seam | Merge | 03 | internal handler; __piHermesStaleCheck seam kept |
| 10 | knowledge ingest (walk+jsonl+zk seam) | Keep | — | |
| 11 | knowledge search (zk graph retrieve) | Keep | — | auto-tree expansion deferred to follow-up effort |
| 12 | knowledge heal | Keep | — | |
| 13 | dictionary kg extractor | Keep | — | sole extractor after 07 |
| 14 | LLM kg extractor | Cut | 07 | kg.llm path removed |
| 15 | 3-tier drift reconciliation | Keep | — | honored (D7) |
| 16 | HNSW warm path | Keep | 05 | surreal now default |
| 17 | cosine cold fallback | Keep | 05 | stays as cold path |
| 18 | FTS5 search | Keep | 05 | sqlite fallback backbone |
| 19 | image cards (OCR+vision) | Keep | — | user-approved keep |
| 20 | procedural skills | Keep | — | |
| 21 | two-tier project memory | Keep | — | |
| 22 | autocommit §-merge driver | Keep | — | |
| 23 | secret scanning | Keep | — | |
| 24 | md↔DB sync | Keep | — | |
| 25 | heat/worth scoring | Keep | — | user-approved keep |
| 26 | interview/insights/switch commands | Cut | 07 | user-approved cut |
| 27 | migrations | Partial | 06/09 | near-dup migration state may drop |

Kept-fraction (Keep=1, Merge=1, Partial=0.5, Cut=0): 20 + 4 + 0.5 = 24.5 / 27 = **90.7%** (target ≥80% — headroom for implementation drift).

## Acceptance targets
- src LOC: from 27173 → ≤ ~15k (40-50% cut)
- tool surface: 10 → 6, schema-cost pin ALL 6, budget ≤2100 tok (5-tool pin 1550/≤1700 stays)
- kept-fraction ≥80% at acceptance accounting (ticket 11)
