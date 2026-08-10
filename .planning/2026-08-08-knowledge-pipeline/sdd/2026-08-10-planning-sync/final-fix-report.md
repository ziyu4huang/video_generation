# 09-impl FINAL-FIX-WAVE Report

Owner: SDD FINAL-FIX-WAVE IMPLEMENTER (ticket 09-impl)
Branch: `knowledge-pipeline/09-impl-planning-sync`
Scope: 2 system-level bugs found by the whole-branch review (invisible to per-task
tests, which all start from a fresh DB) + 1 minor ride-along.

Method: strict TDD — regression tests written FIRST and confirmed RED before the
fix, then GREEN after.

---

## FINDING A — 🔴 CRITICAL: silent mass-deletion of planning cards

### Production bug
`reconcilePlanningDeletions` (T4) needs the COMPLETE present-set to safely
hard-delete vanished cards. T6's background backfill feeds it a BOUNDED subset
(`≤ PLANNING_BACKFILL_MAX_FILES = 50` of this repo's 948 `.planning` md), and
reconcile ran UNCONDITIONALLY → it hard-deleted every DB planning card whose id
was not in the bounded subset (i.e. the ~898 cards outside the first 50).

### Fix — dedicated `partialWalk` opt (NOT overloading `planningOnly`)
`planningOnly` means "skip the zk path"; the new `partialWalk` means "the
present-set is partial/bounded; do NOT run delete-reconciliation".

**`src/walk-and-ingest.ts`** — new opt + gated reconcile call:
```ts
// in WalkAndIngestOptions:
/** PARTIAL WALK (09-impl final review A): the present-set of planning md is
 *  PARTIAL/BOUNDED ... When true, delete reconciliation (step 8c) is SUPPRESSED ...
 *  Reconcile runs ONLY on a COMPLETE present-set ... Mirror (T3) + conflict-marker
 *  scan (T5) stay enabled in either mode. Default false. */
partialWalk?: boolean;

// step 8c (was unconditional):
if (!opts.partialWalk) {
  await reconcilePlanningDeletions(walk.files.planning, opts.memoryDir);
}
```
The `planningOnly` doc comment was rewritten so it no longer claims reconcile runs
in planningOnly mode — it clarifies reconcile is gated on `!partialWalk` (needs a
complete present-set). Mirror (T3) + conflict-marker scan (T5) STAY enabled in
planningOnly/partialWalk.

**`src/handlers/planning-backfill.ts`** — the bounded backfill call:
```ts
await walkAndIngest(files, { memoryDir, planningOnly: true, partialWalk: true });
```
The backfill now mirrors + flags conflicts but NEVER reconciles. Its top-level and
inline comments were updated to reflect the suppression.

### Regression test (A)
`__tests__/walk-and-ingest.test.ts` →
`walkAndIngest — partial walk must NOT reconcile (09-impl final review A)`.

**Scenario:** mirror 3 planning tickets via a COMPLETE walk over the repo root
(hashes written); then run a PARTIAL/bounded walk (`partialWalk:true`,
`planningOnly:true`) over a proper SUBSET (only ticket 01). Assert ALL THREE
tickets still exist in the DB afterwards.

**Why it catches the production bug:** the production condition is "reconcile
fed a bounded subset". Every per-task T4 test passes a COMPLETE present-set (it
walks the full root and only unlinks the truly-deleted file) → it can never
exercise a partial present-set. This test is the only one that passes a subset.

**TDD evidence:**
- RED before fix → `AssertionError ... actual: [ "planning-ticket:partial-eff:01" ]`
  expected all three (tickets 02 + 03 were mass-deleted).
- GREEN after fix → all three survive.

---

## FINDING B — 🟠 IMPORTANT: 08→09 migration cohort frozen + drift masked

### Production bug
For a PRE-09 card (`existing ≠ null`, `stored === null` — true for EVERY existing
planning card on first 09 touch, since `card_md_hash` is brand-new empty), the
branch `existing === null || stored === null` routed to `upsertCard`, which
consults `PlanningTicket/EffortDedupStrategy` and returns `{action:"skip"}` for an
existing id → NO content write; yet `upsertHash` seeded the hash to the CURRENT md.
Result: the DB row stayed at 08-era content, the hash falsely claimed "current",
and every future run saw `stored.hash === incoming` → "unchanged" → drift never
corrected. Violated the DoD ("re-mirror changed cards") for the entire migration
cohort.

### Fix — split the branch in BOTH callers so existing-but-unhashed → UPDATE
**`src/walk-and-ingest.ts` → `mirrorPlanningToStore`:**
```ts
if (existing === null) {                       // truly new → INSERT
  await store.upsertCard(card);
  await upsertHash(store, card.id, incomingHash);
  planningMirrored++;
} else if (stored === null || stored.hash !== incomingHash) {  // 08→09 backfill OR drift → UPDATE
  await store.updateCard(card);
  await upsertHash(store, card.id, incomingHash);
  planningMirrored++;
}
// else: hash match → skip (unchanged)
```
**`src/store/planning-sync-state.ts` → `refreshPlanningCard`** — same split, mapped
to the action union: `existing===null` → `{action:"inserted"}`; `stored===null ||
mismatch` → `{action:"updated"}`; else `{action:"unchanged"}`; source gone →
`{action:"absent"}`.

`updateCard` BYPASSES dedup (pure id-upsert dedup would no-op an existing id) —
correct and intended; the sync layer decides WHEN to call it.

### Regression test (B) — two arms
1. **`__tests__/walk-and-ingest.test.ts`** →
   `walkAndIngest — 08→09 migration cohort unfreeze (09-impl final review B)`.
   **Scenario:** pre-seed a `memories` planning row (existing≠null) with OLD
   content and NO `card_md_hash` row (stored===null); write md with DRIFTED (new)
   content; run the mirror. Assert the DB row content is the NEW md (not skipped)
   AND the hash is seeded.
2. **`src/store/planning-sync-state.test.ts`** →
   `refreshPlanningCard — 08→09 migration cohort (09-impl final review B)`.
   Same pre-seed; run `refreshPlanningCard`; assert `action === "updated"`, content
   updated, hash seeded.

**Why it catches the production bug:** the existing T3 "UPDATEs an edited ticket"
test only reaches UPDATE via `stored≠null + mismatch` (it INSERTs first, which
writes the hash, THEN edits). It can never exercise the `existing≠null &&
stored===null` arm. The migration cohort (existing row, no hash) is exactly that
arm.

**TDD evidence:**
- RED before fix (walk) → `AssertionError ... actual: "OLD 08-era body."`
  expected `/NEW 09-era body\./` (the row was frozen; upsertCard no-op'd).
- RED before fix (refresh) → `AssertionError ... actual: "inserted"`
  expected `"updated"` (routed to the insert arm instead of update).
- GREEN after fix → both arms UPDATE the row + seed the hash.

---

## T6(a) — 🟡 MINOR ride-along: `waitForPlanningBackfill` in the shutdown drain

`src/index.ts` session_shutdown handler (≈line 617) already drains
`waitForSessionBackfill` + `waitForLiveSessionIndex` before `indexSession`.
Added `waitForPlanningBackfill(...)` to the same `Promise.all` for graceful
in-flight drain (consistency with session backfill + prevents orphaned timers):
```ts
await Promise.all([
  waitForSessionBackfill(SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS),
  waitForLiveSessionIndex(SESSION_LIVE_INDEX_SHUTDOWN_TIMEOUT_MS),
  // T6(a): drain in-flight planning backfill too (graceful shutdown,
  //  consistency with session backfill, prevents orphaned timers).
  waitForPlanningBackfill(SESSION_BACKFILL_SHUTDOWN_TIMEOUT_MS),
]);
```
The import was extended to `import { schedulePlanningBackfill, waitForPlanningBackfill }`.
(The bundle-swap quiesce at ≈line 256 was intentionally NOT touched — planning
backfill is session-scoped, not bundle-scoped.)

---

## DO NOT: Finding C (factor a shared drift-decision helper)
Deferred per the brief — optional DRY refactor, not load-bearing. The fix stays
minimal and focused on A + B + T6(a). The two split branches are intentionally
independent so each call-site's action union stays explicit.

---

## Full-suite gate (run ONCE)

Command: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`

- `bun run check` (`tsc --noEmit`): **CLEAN** (zero errors).
- `bun test`: **1440 pass / 1 skip / 1 fail** across 124 files (1048 expect calls).

Baseline before fix = 1437 pass / 1 skip / 1 fail. This wave adds exactly 3 new
regression tests (A + B-walk + B-refresh) → 1437 + 3 = **1440 pass**.

The single failure is the **known pre-existing** ticket-04 time-bomb, UNRELATED
to this work:
`numeric isolation — assembled prompt never leaks memworth ... >
 formatForSystemPrompt never emits memworth ...`
(`tests/store/memory-store.test.ts:2630`). Not touched.

**Zero new failures.** All prior T1–T7 tests still pass. A + B regression tests
GREEN.
