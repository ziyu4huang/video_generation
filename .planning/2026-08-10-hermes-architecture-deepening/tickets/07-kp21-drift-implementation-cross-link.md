---
type: task
status: open
claimed:
blocked by: 06 (C3 sqlite-backend split)
---
# 07 — kp21 drift implementation (cross-link)

Work item tracked on the kp map: [kp 21 — three-tier drift implementation](../../2026-08-08-knowledge-pipeline/tickets/21-three-tier-drift-implementation.md). THIS ticket tracks only wave sequencing on this map (two-live-maps rule).

## Design pins (2026-08-16 grilling)
- Tier-1 = per-file content hash in SQLite metadata, replacing the inert `driftStub` (walk-and-ingest.ts).
- Tier-2 = derived-cache invalidation on md change.
- Tier-3 = DB-authoritative opt-in.
- NEVER reuse `merge-plan.ts` as the drift resolver — it is an LLM consolidation merge; only its hash primitives carry over.

## Sequencing
- After C3 (ticket 06): the split lands first so drift builds on the re-shaped backend.

## Progress
- 2026-08-16: Tier-1 shipped (see kp 21); Tier-2 residual moved to knowledge-card scope; Tier-3 pending.
