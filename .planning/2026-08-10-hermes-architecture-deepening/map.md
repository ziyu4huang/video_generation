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

## Sequencing (2026-08-12 — from knowledge-pipeline self-reflection)

Candidates live in `architecture-review-2026-08-10.md`. Re-sequenced 2026-08-12 against the kp self-reflection:

- **Before kp ticket 13 (memory-card migration):** C1 (codec unification), C5 (Card-abstraction finish — PROMOTED from defer), C6 (NEW — dedup into MemoryRepository contract). These are the convergence moves 13 needs.
- **Rolling / independent of 13:** C2 (skills-command split), C3 (sqlite-backend split — IN-FLIGHT, coordinate with kp Phase-2), C4 (index.ts composition root).

Rationale: sequencing C1/C5/C6 before 13 keeps the memory-card migration mechanical + low-risk (as kp ticket 05 intends); deferring them makes 13 the integration flashpoint. Detail + refreshed candidate leverage in the review doc's `## Top recommendation`.

- 2026-08-15: C1 CLOSED — v1 was #1196 (`splitFencedYaml` leaf); residual `planning-parse.ts` hand-rolled copy rewired to the leaf + sole-source regression gate + planning golden round-trip (ticket 01). Next convergence prerequisite for kp ticket 13: C5.
- 2026-08-15: C5 re-scoped to C5-LITE — decisions in `tickets/02-c5-lite-card-abstraction.md`; closed (#1346 / 7a723437).
