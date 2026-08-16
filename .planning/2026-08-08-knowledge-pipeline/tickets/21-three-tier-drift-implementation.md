---
type: task
status: open
blocked by: (none — independent of 13)
---
# 21 — Implement the 3-tier md↔DB drift policy (Tier-2/3 beyond the Tier-1 stub)

## Question
Close decision 05's field-classification gap: the Tier-1 re-index hook at `walk-and-ingest.ts:82` is inert (stub from 06b), Tier-2 derived-cache invalidation and Tier-3 DB-authoritative opt-in are unimplemented.

## Constraints
- Do NOT reuse `merge-plan.ts` as the drift resolver — it is an LLM consolidation merge; only its hash primitives carry over (kp map Notes, 2026-08-12).
- .planning stays git-canonical (Tier-1: md wins) per shipped ticket 09.

## Acceptance
- Tier-1 drift re-index actually fires on ingest (replaces the inert stub).
- Tier-2 derived caches invalidated on md change.
- Tier-3 opt-in DB-authoritative fields round-trip md↔DB.
- Opened 2026-08-15 from the standing "candidate fresh ticket (pending HITL)" note — HITL confirmed.

## Cross-effort links
- Claimed by: `.planning/2026-08-10-hermes-architecture-deepening` — simplify-&-robusten wave (ticket 07 there tracks wave sequencing; the work item STAYS on this map). Sequenced AFTER the C3 sqlite-backend split; Tier-1 design pinned = per-file content hash in SQLite metadata (replaces the inert driftStub). (2026-08-16)

## Tier-1 DONE (2026-08-16)
- mirrorVaultMdToStore now hash-gates the vault-md mirror (planningContentHash vs card_md_hash kind='vault-md'): INSERT/skip/UPDATE arms + md-wins deletion sweep (listCardMdHashes accessor, all 5 card-store layers, surreal SQLITE_ONLY throw + driftDisabled fallback). Receipt driftStub += changed/unchanged/removed/driftDisabled; echo fields preserved. Gates: tsc clean; 1634/0 (new receipt-arms test). Tier-1 design pin honored: per-file content hash in SQLite metadata, stub replaced by live comparison.
- Tier-2 assessment: vector backfill ALREADY delta-aware; healGraph refreshes every walk (never stale). Remaining Tier-2 gap = entity-summaries side-cache, which lives in pi-agent-ext-knowledge-card (kp 03-Phase2) — NOT hermes-memory; separate small ticket there when taken.
- Tier-3 (DB-authoritative opt-in round-trip): still open.
