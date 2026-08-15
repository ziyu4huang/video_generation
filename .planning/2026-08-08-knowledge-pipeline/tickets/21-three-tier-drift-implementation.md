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
