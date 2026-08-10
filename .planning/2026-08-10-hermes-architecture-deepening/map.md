---
status: active
---
# Hermes-memory architecture deepening

## Destination
Deepen `bun-apps/pi-agent-ext-hermes-memory`'s architecture: turn its shallow modules into deep ones, guided by the `improve-codebase-architecture` skill's 2026-08-10 scan. Scan report: `architecture-review-2026-08-10.md`. Candidate picked -> grilling -> spec -> plan -> execute.

## Notes
- Scan base: HEAD `e1aa0e33` on `feat/improve-codebase-arch`; target `bun-apps/pi-agent-ext-hermes-memory/src` (94 non-test files, ~21,728 LOC; tests 26,353 LOC, ratio 1.21).
- Coordinate with knowledge-pipeline Phase-2 (08-impl) -- several candidates touch in-flight files (sqlite-backend, schema, card-store, walk-and-ingest).
- Prior art: `2026-08-08-wayfind-architecture-deepening` (COMPLETE) shipped the same codec-unification pattern this scan re-found in hermes.
