# kp-13 Wave A — session handoff (zk-spawn)

Status: **DONE — committed, pushed, PR open (NOT merged, per instructions).**

## Artifact
- Branch: `feat/kp13-wave-a-card-store-dual-backend` (commit `d61f22f9`)
- Worktree: `/tmp/kp13-wave-a` (kept for review gate; safe to remove after merge with
  `git worktree remove /tmp/kp13-wave-a` from the main repo)
- PR: https://github.com/ziyu4huang/video_generation/pull/1363
- Spec: `.planning/2026-08-08-knowledge-pipeline/specs/13-memory-card-graduation.md`
- Plan: `.planning/2026-08-08-knowledge-pipeline/plans/13-three-waves.md` (Wave A section)

## What shipped (5 files, 771 insertions / 116 deletions)
1. `src/store/card-store.ts` — persistence extracted behind internal `CardPersistence`
   seam. SQLite impl = 06a SQL verbatim (standalone quick path still constructs its
   backend via C5-lite factory seam and OWNS it; bundle path reuses the bundle's
   handle via new `sqliteBackend` option). Surreal impl = over
   `SurrealMemoryRepository`: `insertCard` rides `addMemory` (C6 exact-dup dedup
   inherited) + `setCardEnvelopeBySeq` stamps frontmatter/graph JSON as SCHEMALESS
   free columns. NO new Surreal record types. Throws-on-surreal GONE
   (`dbBackend?: "sqlite" | "surrealdb"` + `surrealRepo` option).
2. `src/store/surreal/surreal-memory-repo.ts` — 5 concrete card-seam methods
   (NOT on shared MemoryRepository interface): `getCardByMdId`,
   `listCardsByTarget`, `updateCardByMdId`, `deleteCardByMdId` (cleans `tagged`
   edges), `setCardEnvelopeBySeq`; exported `SurrealCardRow`.
   NOTE: `CARD_FIELDS` includes `seq` in the projection ONLY to satisfy
   SurrealDB v3's "ORDER BY idiom must be selected" rule.
3. `src/store/repository.ts` — `BackendBundle` gains `cardStore: CardStore`.
4. `src/store/backend-factory.ts` — both branches construct bundle cardStore
   (sqlite: shared handle; surreal: over bundle's repo). Fallback + hot-swap
   inherit it automatically — index.ts UNTOUCHED.
5. `src/store/card-store-dual-backend.test.ts` — 8 contract tests (both kinds ×
   both backends, C6 dedup ride, SQLITE_ONLY throws, bundle join, fallback,
   hot-swap re-bundle). Surreal tests gate on reachability probe, isolated
   ns/db `test_hermes_kp13a`/`kp13_wave_a`.

## Key decisions
- md/dep-hash accessors: **sqlite-only, THROW documented SQLITE_ONLY error on
  surreal** (least-lie vs no-op). Consumers (Tier-1 planning mirrors) are
  sqlite-scoped today.
- Sole-source gate NOT extended — construction didn't move; existing gate green.
- Surreal C6 caveat (documented in code + PR): an exact-content dup from another
  flow keeps ITS mdId; cross-flow identity collision is Wave B's concern.

## Verification
- `bunx tsc --noEmit` clean; `bun test` 1614 pass / 0 fail / 1 pre-existing
  unrelated skip (md_id schema sqlite test).
- SurrealDB was UP locally (port 8000) — all 4 surreal tests ran LIVE, 0 skips.
- No `--no-verify`, no lockfile drift, explicit-path staging only.

## Next (Wave B — NOT started)
- Re-point memory writers (tools/memory-tool.ts, memory-supersede-tool.ts,
  grill-decision-tool.ts, handlers/correction-detector.ts, error-detector.ts,
  sync-markdown-memories.ts, review-memory-ops.ts) from syncMemoryEntry mirror →
  cardStore upsert/update; lazy re-migration by md_id (idempotent).
- Gate: zero syncMemoryEntry calls on memory-kind paths (grep test).
