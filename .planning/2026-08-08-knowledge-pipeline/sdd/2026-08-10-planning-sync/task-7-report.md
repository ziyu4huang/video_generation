# Task 7 Report — on-demand planning refresh (09-impl T7, FINAL task)

**Status:** DONE
**Commit:** `f80328ab feat(knowledge-pipeline): on-demand planning refresh (09-impl T7)`
**Branch:** `knowledge-pipeline/09-impl-planning-sync` (parent `09a92aa2` = T6)

## What was implemented

The EXPLICIT on-demand planning-card refresh — the third freshness mechanism (alongside T6
background backfill on session_start and the T3 mirror itself). A caller can now ask
"re-sync THIS one card now": re-read its source md, re-deserialize, re-hash, and re-mirror
through the SAME hash-compare branch as the mirror, with a new ABSENT arm when the source md
has vanished. Regular reads (`getCard`/`getCardsByKind`) remain NON-rehashing — documented in
the module header.

Two new exports in `src/store/planning-sync-state.ts`:

- `refreshPlanningCard(store, cardId, fsRoot): Promise<{ action: RefreshAction }>`
  where `RefreshAction = "inserted" | "updated" | "unchanged" | "absent"`.
- `refreshIfStale(store, cardId, fsRoot): Promise<boolean>` — true iff `inserted|updated`.

### Refresh branch (mirrors T3's `mirrorPlanningToStore` exactly + ABSENT)

```ts
// Same hash-compare branch as the T3 mirror (walk-and-ingest.mirrorPlanningToStore):
const incomingHash = planningContentHash(card);
const existing = await store.getCard(cardId);
const stored = await getStoredHash(store, cardId);
if (existing === null || stored === null) {            // INSERT
  await store.upsertCard(card);
  await upsertHash(store, cardId, incomingHash);
  return { action: "inserted" };
}
if (stored.hash !== incomingHash) {                    // UPDATE (drift)
  await store.updateCard(card);
  await upsertHash(store, cardId, incomingHash);
  return { action: "updated" };
}
return { action: "unchanged" };                        // hash match → no write
```

The ABSENT arm fires BEFORE that branch: if the re-derived source path is unresolvable,
the read throws, the id prefix is unrecognised, the serializer is missing, or no card with
`cardId` is produced by deserialization → `{ action: "absent" }` with **NO delete** (the caller
decides; T4's `reconcilePlanningDeletions` hard-deletes during walks). This is the only
behavioural addition over T3's branch.

### Pinned source-path re-derivation (`sourcePathForId`, private)

Because `card_md_hash` keys by `card_id` only (NO `source_path` column — DDL pinned in T1),
the source md path is recovered from the id:

```ts
// planning-effort:<effort>      → <fsRoot>/.planning/<effort>/map.md
// planning-ticket:<effort>:<no> → glob <fsRoot>/.planning/<effort>/tickets/<no>-*.md
//   (id carries effort+no, NOT the slug — slug recovered by readdirSync + startsWith)
```

The DDL is unchanged; no `source_path` column was added. A missing tickets dir is caught
(`readdirSync` → null), satisfying the ABSENT case for a vanished effort.

### JSDoc / module header — non-rehashing reads documented

The module header now states the freshness model explicitly:

> Freshness model (T6/T7): regular reads — CardStore.getCard / getCardsByKind — return the DB
> row AS-IS (fast; NO re-hash, NO re-read of source md). Planning freshness is provided by
> exactly two mechanisms, NEVER an every-read-rehash:
>   1. the T6 background backfill on session_start (best-effort, non-blocking), and
>   2. the T7 on-demand refreshPlanningCard/refreshIfStale below (explicit, per-card).

`refreshPlanningCard`'s JSDoc repeats: "regular getCard/getCardsByKind do NOT re-hash".

## Files changed (exactly 2 in-scope; `walk-and-ingest.ts` NOT modified)

1. `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.ts`
   - Added imports: `readFileSync`, `readdirSync` (`node:fs`); `join` (`node:path`).
   - Added exported `type RefreshAction` + private `sourcePathForId` + exported
     `refreshPlanningCard` + `refreshIfStale`.
   - Expanded module header with the non-rehashing freshness model.
2. `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.test.ts`
   - Added 4 refresh tests (inserted / updated-drift / unchanged / absent) + a
     `refreshIfStale → false` assertion in the unchanged case. Appended a new
     `describe("refreshPlanningCard (09-impl T7)")` block.

`git diff --stat src/walk-and-ingest.ts` is **empty** — T3's mirror was NOT refactored. Per
the anti-scope-creep discipline, the refresh branch is replicated INLINE using T2's helpers
(`planningContentHash`, `getStoredHash`, `upsertHash`) + the store's `upsertCard`/`updateCard`,
NOT via a shared-helper extraction. The brief did not mandate a shared-helper refactor.

## TDD evidence

**RED (Step 2)** — functions absent; module fails to load:
```
SyntaxError: Export named 'refreshIfStale' not found in module '.../planning-sync-state.ts'.
0 pass / 1 fail / 1 error
```

**GREEN (Step 4)** — scoped `bun test src/store/planning-sync-state.test.ts`:
```
13 pass / 0 fail
```
All 4 new T7 refresh cases pass (inserts / updates-drift / unchanged / absent) plus the
pre-existing 5 hash + 4 round-trip cases.

## Full-suite gate (Step 5 — run exactly once)

```
bun run check   →  tsc --noEmit  EXIT 0  (clean)
bun test        →  1437 pass / 1 skip / 1 fail
```

- **1437 pass** = baseline-after-T6 (1433) + 4 new T7 refresh tests. ✅
- **1 skip**: `md_id schema > SQLite: md_id is unique among non-NULL values` (pre-existing).
- **1 fail**: `formatForSystemPrompt never emits memworth (memory + failure blocks —
  regression pin)` at `tests/store/memory-store.test.ts:2630` — the documented pre-existing
  ticket-04 time-bomb, UNRELATED to this work. **Zero new failures.**

## Self-review

- ✅ Refresh decision mirrors T3's exact branch (`existing===null || stored===null` → INSERT;
  `stored.hash !== incoming` → UPDATE; else unchanged) byte-for-byte — verified by reading
  `mirrorPlanningToStore` lines 306–320.
- ✅ ABSENT arm is reached before any write and performs NO delete — caller decides; T4 sweep
  owns deletion. Matches the brief's "NO delete" mandate.
- ✅ `refreshIfStale` returns true iff inserted|updated; test asserts `false` in the
  unchanged case.
- ✅ Source-path re-derivation handles both id shapes; missing dir / vanished file /
  unrecognised id all funnel to ABSENT.
- ✅ Path re-derivation does NOT depend on the slug — ticket id carries `effort:no` and the
  slug is recovered by `readdirSync` glob (the pinned design).
- ✅ `serializerFor` / `deserialize` usage matches the mirror's pattern
  (`deserialize(bytes, { filePath: src })` then `.find(c => c.id === cardId)`).
- ✅ Module header + JSDoc document that regular reads are non-rehashing (DoD satisfied).
- ✅ DDL unchanged — no `source_path` column added.
- ✅ Scope held: only 2 files touched; `walk-and-ingest.ts` untouched; no shared-helper
  refactor.

## Concerns

None. The interface line in the brief's "Interfaces" section lists a 3-arm return
(`"inserted" | "updated" | "unchanged"`) but the brief's own Step-3 implementation +
Step-1 test case (d) require the 4-arm `absent`. I followed the implementation + tests
(4-arm `RefreshAction`), which is self-consistent with the task label's "action-union return"
and the ABSENT-arm mandate. No ambiguity blocked progress.
