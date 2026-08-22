# PRD — s2-agent-ext-hermes-memory

## Problem

Pi agents forget everything between sessions. Workflow self-improve loops, failures, corrections, and user preferences need durable storage that survives across sessions and is queryable at runtime.

## Solution

Persistent memory + session search + secret scanning for Pi. Stores categorized memories (failures, corrections, insights, conventions, tool-quirks, preferences) in flat markdown files under `~/.pi/agent/pi-hermes-memory/`. Indexes past sessions for semantic search. Background learning reviews every N turns and saves what matters. Auto-consolidates entries when full.

## Tools / Commands

| Tool/Command | Description |
|--------------|-------------|
| `memory` | Save/query/audit persistent entries across targets (memory, user, project, failure) |
| `memory_search` | Search extended memory store with category/project filters |
| `session_search` | Search indexed past conversation messages |
| `skill_manage` | Create/inspect/update reusable procedural skills |
| `/memory-index-sessions` | One-time index of past sessions |
| `/memory-sync-markdown` | Backfill older markdown memories |

## Key Dependencies

- Self-contained (works across Pi sessions)
- Consumed by `s2-agent-ext-knowledge-card` (zk_ingest --source hermes)

## Install

```bash
pi install npm:pi-hermes-memory
```

## Decision: Vector path RETIRED — hermes folds to a capture-only journal (2026-08-22)

The two former decisions below (Vector/search backend 2026-08-09, Embed index build
policy 2026-08-09) are SUPERSEDED. Measured 2026-08-19
(`.planning/knowledge/hermes-recall-audit.md`): the `vectors` SurrealDB database was
never created, so every armed semantic query served a zero-row lexical fallback —
hit@1/3/5 = 0/20, MRR 0.000. The card_vectors HNSW side-table, its vector backfill,
`searchSemantic`, and the knowledge_search semantic opt-in were deleted
(context-lifecycle ticket 03 / D1 — `.planning/2026-08-22-context-lifecycle/`).
Re-arming is rejected: it would duplicate kcard `retrieveRecords`' measured 1.00
semantic blend (knowledge-card ext) — recall routes there, exclusively.

What stands: SurrealDB remains the PRIMARY backend for the CRUD journal store
(store of record for the capture journal — sqlite fallback unchanged); the bge-m3
canonical-model resolution (D3) lives in `@repo/s2-agent-core-interface`
`resolveSemanticEmbedConfig`; the LeanRAG hierarchy build keeps its LM Studio
embedder injection.

## Cross-reference

- `bun-apps/KNOWLEDGE-LAYER.md` — 3-layer knowledge system map (the retired knowledge-orchestration.md's successor)
- `bun-apps/s2-agent-ext-knowledge-card/` — convergence sink consuming this store
