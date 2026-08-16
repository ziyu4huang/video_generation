---
ticket: 09
status: open
blocked-by: [04]
---

## Goal

Remove dead code: `Card.embed` never-persisted field, the generic-deferred ingest family, and the unused serializer family.

## Scope

- Grep-verified unused items only — no live references may be deleted.

## Acceptance

- Typecheck + `bun test` green.
- LOC delta recorded.
