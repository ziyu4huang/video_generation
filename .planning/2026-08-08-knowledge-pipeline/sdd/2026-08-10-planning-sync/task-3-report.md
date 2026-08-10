# Task 3 Report — planning mirror UPDATE path + `store.updateCard` (09-impl T3)

**Status:** DONE
**Commit:** `45e1cc68` — `feat(knowledge-pipeline): mirror UPDATE path + store.updateCard (09-impl T3)`
**Branch:** `knowledge-pipeline/09-impl-planning-sync` (HEAD advanced `62950249` → `45e1cc68`)
**Package:** `bun-apps/pi-agent-ext-hermes-memory`

## What this task did

T3 makes the `.planning` mirror **self-correcting**. Instead of 08-impl's
append-only `upsertCard` (which silently skips any card whose id already exists,
so an edited ticket never propagates), the mirror now hash-compares each incoming
planning card against the stored hash and branches:

- **INSERT** — card absent OR no stored hash (`getCard` null / `getStoredHash`
  null, incl. legacy 08-impl cards mirrored before the `card_md_hash` table
  existed) → `upsertCard` (dedup `keep`) + `upsertHash`.
- **UPDATE** — stored hash ≠ incoming (`stored.hash !== incomingHash`, md edited)
  → `updateCard` (Tier-1 md-wins refresh, **bypasses dedup** — pure identity
  cannot express "update"; the `DedupDecision` union is keep/merge/skip) +
  `upsertHash` refresh.
- **skip** — hash match → no write (cheap).

Dedup is consulted **only** on the INSERT identity check; the UPDATE branch goes
straight to SQL. The mirror walks T2's accessors (`planningContentHash`,
`getStoredHash`, `upsertHash` from `src/store/planning-sync-state.ts`) — no raw
SQL against `card_md_hash` in the sync layer.

Per the dispatcher's T3↔T5 conflict-preemption directive, the `WalkAndIngestReceipt`
type AND `mirrorPlanningToStore`'s return BOTH gained a `conflictMarkerEfforts:
string[]` field NOW (set to `[]` at both return points). T5 will only **populate**
it later by scanning md bytes — it will not need to re-add the field/type.

## Files changed (3 in-scope)

### 1. `src/store/card-store.ts` — new `updateCard`

Interface (after `upsertCard`):
```ts
  /** 09-impl: Tier-1 md-wins refresh — UPDATE an EXISTING card's content +
   *  frontmatter (NOT a new row). Bypasses dedup (pure identity cannot express
   *  "update"; the sync-layer hash-compare decides WHEN to call this). */
  updateCard(card: Card): Promise<void>;
```

Impl (same `runWithTransientRetry`/`withCorruptionRecovery` envelope as
`upsertCard`, keyed off `md_id = Card.id`):
```ts
    async updateCard(card: Card): Promise<void> {
      await runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          getDb()
            .prepare(
              `UPDATE memories
                 SET content = ?, frontmatter = ?, last_referenced = ?
               WHERE md_id = ?`,
            )
            .run(card.content, JSON.stringify(card.frontmatter), today(), card.id);
        }),
      );
    },
```

### 2. `src/walk-and-ingest.ts` — `mirrorPlanningToStore` hash-compare branch + receipt field

New import:
```ts
import { planningContentHash, getStoredHash, upsertHash } from "./store/planning-sync-state.js";
```

`WalkAndIngestReceipt` gains the reserved field:
```ts
  planningMirrored: number;
  /** Effort ids whose md carries a conflict marker (scanned in T5). Empty in
   *  T3 — the field is reserved NOW so T5 is a pure populate-change. */
  conflictMarkerEfforts: string[];
```

The mirror body (per-card branch):
```ts
      for (const card of cards) {
        const incomingHash = planningContentHash(card);
        const existing = await store.getCard(card.id);
        const stored = await getStoredHash(store, card.id);
        if (existing === null || stored === null) {
          // New card (or first mirror after 08→09): INSERT through dedup, write hash.
          await store.upsertCard(card);
          await upsertHash(store, card.id, incomingHash);
          planningMirrored++;
        } else if (stored.hash !== incomingHash) {
          // Drift (md edited): Tier-1 md-wins UPDATE + refresh hash.
          await store.updateCard(card);
          await upsertHash(store, card.id, incomingHash);
          planningMirrored++;
        }
        // else: hash match → skip (no write).
      }
```

Call site (step 8b) + both receipt returns carry `conflictMarkerEfforts` (the
`ok:false` early return sets `[]`; the `ok:true` return threads the local from
`planMirror.conflictMarkerEfforts`).

### 3. `__tests__/walk-and-ingest.test.ts` — new describe block (verbatim from brief)

`describe("walkAndIngest — planning mirror drift (09-impl T3)", ...)` with 3
cases: (a) INSERTs a new ticket; (b) UPDATEs an EDITED ticket (hash mismatch)
instead of skipping; (c) SKIPS an UNCHANGED ticket (hash match, `planningMirrored`
0 on re-mirror).

## TDD evidence

### RED (before implementation)

Command: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/walk-and-ingest.test.ts )`

```
(fail) walkAndIngest — planning mirror drift (09-impl T3) > UPDATEs an edited ticket (hash mismatch) instead of skipping [9.03ms]
   ... assert.match(c?.content ?? "", /EDITED body\./)   → content stayed "Original." (08 append-once dedup skipped the existing id)
(fail) walkAndIngest — planning mirror drift (09-impl T3) > skips an UNCHANGED ticket (hash match — no write) [6.13ms]
   ... assert.equal(r2.planningMirrored, 0)   → got 1 (08 mirror has no hash-skip)
 7 pass
 2 fail
```
Exactly the 2 expected REDs (UPDATE + skip); the INSERT case already passed
(unchanged behavior for a fresh card).

### GREEN (after implementation)

Command: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/walk-and-ingest.test.ts )`

```
(pass) walkAndIngest — planning family (seam-independent) > mirrors .planning/ into the card-store without the zk seam   ← 08 pre-existing, still green
(pass) walkAndIngest — planning mirror drift (09-impl T3) > INSERTs a new ticket (no stored hash)
(pass) walkAndIngest — planning mirror drift (09-impl T3) > UPDATEs an edited ticket (hash mismatch) instead of skipping
(pass) walkAndIngest — planning mirror drift (09-impl T3) > skips an UNCHANGED ticket (hash match — no write)
 9 pass
 0 fail
```

## Full-suite gate

Command: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`

- `bun run check` (`tsc --noEmit`): **clean** (no errors).
- `bun test`: **1423 pass / 1 skip / 1 fail**.
- Baseline-after-T2 was **1420 pass / 1 skip / 1 fail**; the +3 are exactly this
  task's new tests. The single failure is the known pre-existing ticket-04
  time-bomb `formatForSystemPrompt never emits memworth ...`
  (`tests/store/memory-store.test.ts:2630`) — untouched, unrelated. **Zero new
  failures.**

## Self-review

- **DoD met**: edited ticket → row UPDATED (not skipped); unchanged ticket → skip
  (`planningMirrored` 0 on re-mirror); new ticket → INSERT; 08's planning-walk
  test still green; full suite green.
- `updateCard` matches the existing accessor envelope (`runWithTransientRetry` →
  `backend.withCorruptionRecovery` → prepared statement); the sync layer never
  touches `card_md_hash` SQL directly (goes through T2's `getStoredHash`/
  `upsertHash`/`planningContentHash`).
- The INSERT branch covers the legacy 08-impl case (card exists in `memories`
  with no `card_md_hash` row → `stored === null` → INSERT/upsert path +
  write-hash). This is intentional, not an error.
- `conflictMarkerEfforts` reserved on the type + both returns now → T5 is a pure
  populate-change (no type/receipt churn in T5).
- Git discipline: exactly 3 in-scope files staged by explicit path; the
  `.planning/.../sdd/` scratch dir and the stashed `mlx_native.py` were left
  untouched; exactly one commit.

## Concerns

None blocking.

- **Minor note (not a defect):** the dispatcher's task label specified the commit
  message `feat(knowledge-pipeline): mirror UPDATE path + store.updateCard
  (09-impl T3)`, which differs from the brief's suggested message. I followed the
  dispatcher's task-label message verbatim (the task label is the authoritative
  git-discipline directive; the brief is authoritative for spec/signatures/DoD,
  which were followed verbatim). Flagged here for traceability only.
