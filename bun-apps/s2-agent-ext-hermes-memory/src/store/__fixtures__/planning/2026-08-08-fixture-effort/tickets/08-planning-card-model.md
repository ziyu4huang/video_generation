---
type: grilling
status: closed
claimed: pi/test
blocked by: 01
---
# 08 — Planning-card model

## Question
Pin the planning-card contract. See bun-apps/s2-agent-ext-hermes-memory/src/store/card.ts
and .planning/specs/2026-08-09-knowledge-pipeline-phase2-design.md.

## Resolution (2026-08-09, grilled)
Hermes owns ingest + store; a planning-card serializer plugs into hermes. Each
ticket becomes a planning-ticket card with a resolution-gist; map.md becomes a
planning-effort card. Cites src/store/card-store.ts.
