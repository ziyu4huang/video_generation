---
type: task
status: closed
claimed: 2026-08-15 (grilled; spec+plan done, Wave A in flight)
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

- [x] Existing memory-cards round-trip into the unified store with no content loss (§-entries ↔ `kind: memory` cards).
- [x] hermes read/write/query/dedup work against the unified store (no legacy memory-only path in the hot path).
- [x] A knowledge-card edit and a memory-card edit both flow through the same md→db re-index + derived-cache regeneration (Tier 1 + Tier 2) — Tier-1 scope; Tier-2/3 tracked in ticket 21.
- [x] `bun test` green for hermes-memory + the store layer; the live memory system shows no regression.

## Notes

- Decided by ticket 05 fork 1 (migrate-at-graduation). Migration is mechanical + low-risk by design (01's pluggable serializer); the gate is the store being built + proven, not the migration itself.
- Coexistence during build is intentional — do NOT pull memory-cards in eagerly; the working memory system must stay on its proven path until the new store is green.
- Depends transitively on task 12 (core-interface scaffold) + the store-impl tasks spawned by ticket 06.

## Grilled design (2026-08-15, 2 rounds — supersedes "pure path-switch" note)

- **Backend**: card-store goes DUAL-BACKEND. SQLite keeps the existing SQL impl; Surreal is implemented ON TOP of SurrealMemoryRepository (addMemory — which now carries C6 exact-dup dedup — getCard-by-md_id, list-by-target). No new Surreal record type; Card stays a view over `memories`.
- **Bundle**: card-store joins the shared BackendBundle (constructed in backend-factory, one connection, switch-backend hot-swap applies to cards). Completes C5's one-bundle vision.
- **Write path**: FULL writer re-point — memory tool, memory_supersede, grill_decision, correction/error detectors, sync-markdown-memories all mirror via card-store (md stays canonical via MemoryStore).
- **Migration**: LAZY re-mirror — no one-shot bulk migration; existing §-entries re-mirror through sync-markdown-memories' startup pass now targeting card-store. Existing sqlite rows carry md_id (5d) so graduation matches by id.
- **Drift**: Tier-1 re-index for memory kinds ships IN 13 (walk-path hash-compare mirror, pattern = planning mirror); Tier-2/3 remain ticket 21. Acceptance bullet 3 scoped to Tier-1.
- **Retirement**: legacy memory-mirror path for memory kinds is DELETED at the end (not flag-dormant). memoryRepo keeps serving sessions + non-memory uses.
- **Waves**: 3 PRs — A: card-store dual-backend + bundle join; B: memory mirror via card-store + full writer re-point + lazy re-migration; C: Tier-1 walk mirror + legacy deletion + acceptance harness.

## Wave status
- **A SHIPPED (#1363, 2026-08-15)**: card-store dual-backend (surreal via SurrealMemoryRepository, C6 dedup rides; md/dep-hash SQLITE_ONLY documented) + BackendBundle.cardStore (both branches + fallback + hot-swap). Review SHIP 9/9; 1614 tests green, surreal live 8/8.
- **B SHIPPED (#1372, 2026-08-15)**: all memory-kind mirrors re-pointed to bundle cardStore via new `memory-card-mirror.ts` (add/replace/remove/entry; serializer-registry envelopes, no hand-rolled); sync-markdown startup = lazy re-migration (idempotent, md_id-keyed, real-cardStore tested); delete-by-md-id surfaced + exercised; memory-mirror sole-source grep gate. Runaway-dispatch salvage: payload verified clean. Review SHIP 10/10; 1625 tests green, surreal contract 45/0 live. md-canonical untouched (memory-store.ts zero diff).
- **C SHIPPED (#1378, 2026-08-15)**: Tier-1 memory walk mirror (md-wins, planning-mirror pattern, idempotent); dormant legacy helpers deleted (syncEvictions family; MemoryRepository.sync* retained for ticket 21); acceptance harness 4/4 (surreal parity live). Review SHIP 10/10; 1629 tests green.
- **TICKET 13 COMPLETE.** Graduation milestone reached: memory/user/failure cards live in the unified card-agnostic store; md stays canonical; the store is single. Open build set = {21}.
