---
type: task
status: open
blocked by: 06 (shipped: 06a #1141 + 06b #1146 — gate met)
---
# 13 — Migrate memory-cards into the unified store (graduation milestone)

> **Blocked by 06** (hermes-spine orchestration must be decided AND the unified store built + proven stable on knowledge-cards first). Spawned by ticket 05 fork 1 (migrate-at-graduation). Do not start until the card-agnostic store is live and green on knowledge-cards.
> **Cross-effort sequencing (2026-08-12):** do AFTER the hermes-architecture-deepening convergence moves (`.planning/2026-08-10-hermes-architecture-deepening`): C1 codec unification, C5 Card-abstraction finish, C6 dedup-into-contract. These are the convergence moves this migration needs; sequencing them first keeps 13 mechanical + low-risk (per ticket 05).

## Question / scope

Execute the graduation milestone decided in ticket 05: move hermes's existing section-md memory-cards into the card-agnostic unified store as the FINAL milestone before the knowledge-pipeline effort closes. After this, the old memory-only path is retired and the store is truly single + card-agnostic.

## What to build

- A `kind: memory` serializer slot in the card-agnostic store (the pluggable-serializer hook guaranteed by ticket 01). Memory-cards keep their section-md content shape; only their STORE backing changes (no content rewrite — bulk MEMORY.md→knowledge-card rewrite is explicitly out of scope per ticket 05).
- A one-shot migration that reads the existing memory-cards (MEMORY.md / USER.md / failures.md §-delimited entries) and upserts each into the unified store under `kind: memory`.
- Re-point hermes's read/write path at the unified store (retire the legacy memory-only repository path once parity is verified).
- Verify the 3-tier drift policy (ticket 05 fork 2) holds for `kind: memory` cards: md-canonical fields re-index, no Tier-3 regression.

## Acceptance

- [ ] Existing memory-cards round-trip into the unified store with no content loss (§-entries ↔ `kind: memory` cards).
- [ ] hermes read/write/query/dedup work against the unified store (no legacy memory-only path in the hot path).
- [ ] A knowledge-card edit and a memory-card edit both flow through the same md→db re-index + derived-cache regeneration (Tier 1 + Tier 2).
- [ ] `bun test` green for hermes-memory + the store layer; the live memory system shows no regression.

## Notes

- Decided by ticket 05 fork 1 (migrate-at-graduation). Migration is mechanical + low-risk by design (01's pluggable serializer); the gate is the store being built + proven, not the migration itself.
- Coexistence during build is intentional — do NOT pull memory-cards in eagerly; the working memory system must stay on its proven path until the new store is green.
- Depends transitively on task 12 (core-interface scaffold) + the store-impl tasks spawned by ticket 06.
