# Spec — kp 13: memory-card graduation into the unified store

Status: approved (HITL 2026-08-15). Source: tickets/13 + the grilled design recorded there.

## Problem
Memory kinds (memory/user/failure) still run the legacy md-canonical + memoryRepo.syncMemoryEntry mirror while every other kind (knowledge/planning-*/image) lives in card-store. Convergence prerequisites are landed: C1 codec (#1196, #1343), C5-lite persistableKinds+factory (#1346), C6 addMemory dedup (#1349).

## Design (approved)
See tickets/13 "Grilled design" — dual-backend card-store (surreal via MemoryRepository), bundle join, full writer re-point, lazy re-migration, Tier-1 in scope / Tier-2/3 → ticket 21, delete legacy mirror at the end.

## Waves
- **A — card-store dual-backend + bundle join**: repo-seam inside card-store (sqlite impl as-is; surreal impl over SurrealMemoryRepository using addMemory/getCard semantics with C6 dedup); BackendBundle gains cardStore (factory-constructed, hot-swappable); backend-factory sole-source gate extended if needed.
- **B — memory mirror switch**: syncAddToSqlite & the ~8 writer call sites re-point to card-store upsert/update; sync-markdown-memories startup pass mirrors §-entries into card-store (lazy re-migration by md_id).
- **C — Tier-1 + retirement**: walk-path hash-compare mirror for MEMORY.md/USER.md/failures.md (pattern: planning mirror); delete the legacy memory-kind mirror path; acceptance harness (parity checks per ticket 13's bullets, scoped Tier-1).

## Acceptance (per ticket 13, as scoped)
- §-entries round-trip into card-store with no content loss (all 3 memory kinds).
- Read/write/query/dedup work against the unified store on BOTH backends (sqlite + surreal contract tests); no legacy memory-mirror in the hot path (deleted).
- A knowledge-card edit and a memory-card edit both flow through the same Tier-1 md→db re-index.
- hermes suite green; live memory system shows no regression (parity harness in C).

## Non-goals
Tier-2 derived-cache + Tier-3 opt-in (ticket 21); bulk MEMORY.md content rewrite (05); Surreal-first search changes (04 stands).
