---
ticket: 09
status: done
blocked-by: [04]
---

## Goal

Remove dead code: `Card.embed` never-persisted field, the generic-deferred ingest family, and the unused serializer family.

## Scope

- Grep-verified unused items only — no live references may be deleted.

## Acceptance

- Typecheck + `bun test` green.
- LOC delta recorded.

## Resolution

Removed: Card.embed type-only field (never persisted/indexed — docs already said so; now the type matches reality). KEPT after verification (spec premises stale): memory-serializer family — LIVE, registered per-kind (memory/user/failure) in card-store; triggerConsolidation — LIVE, engine of /memory-consolidate (auto-consolidate.ts:341); generic-deferred classify branch — behavioral skip path, not dead. Ticket 11 acceptance must use verified-live inventory, not spec estimates.
