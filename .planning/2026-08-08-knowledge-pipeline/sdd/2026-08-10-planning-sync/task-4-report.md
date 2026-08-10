# Task 4 Report — planning delete reconciliation (md-wins hard-delete) + `store.deleteCard`

**Ticket:** 09-impl (.planning DB↔md sync)
**Branch:** `knowledge-pipeline/09-impl-planning-sync`
**Commit:** `ef5b3f88` — `feat(knowledge-pipeline): planning delete reconciliation + store.deleteCard (09-impl T4)`
**Spec:** `task-4-brief.md` (verbatim source of truth)

## What was implemented

T4 closes the drift loop's DELETE side: after the planning mirror (T3, step 8b)
runs, any DB planning-card whose source md has VANISHED from disk is hard-deleted
(md-wins; Tier-1). Tombstoning is explicitly out-of-scope for 09 — hard-delete only.

Two new surfaces, both carrying the dual-delete guarantee (memories row AND its
`card_md_hash` row deleted together — orphaned hash rows are a bug):

1. **`CardStore.deleteCard(id): Promise<void>`** — `DELETE FROM memories WHERE md_id = ?`,
   wrapped in the same `runWithTransientRetry(() => backend.withCorruptionRecovery(...))`
   envelope as every other SQL op on the store.
2. **`reconcilePlanningDeletions(presentPlanningFiles, memoryDir?)`** — builds the set
   of Card.ids that are PRESENT on disk (via `parsePlanningPath` → `planningEffortId` /
   `planningTicketId`), then for each stored planning-effort/planning-ticket card whose id
   is NOT in that set: `store.deleteCard(card.id)` + `deleteHash(store, card.id)` together.
   Called from `walkAndIngest` at step 8c, immediately after step 8b (the mirror).

**Receipt field (`planningDeleted`): NOT added.** Per the brief's explicit instruction
("09-impl keeps the receipt minimal — `planningMirrored` + `conflictMarkerEfforts` — and
does NOT add a `planningDeleted` field unless a later task needs it") and the ambiguity
resolution ("if the brief keeps `planningDeleted` only on `reconcilePlanningDeletions`'s
own return and does NOT touch the receipt, follow the brief exactly — do not over-add"),
`planningDeleted` is returned by `reconcilePlanningDeletions` for diagnostics but is NOT
surfaced on `WalkAndIngestReceipt`. The receipt type is byte-for-byte unchanged.

## Files changed (3 in-scope)

```
 bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts |  30 ++++++++++++-
 bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts           |  11 ++++
 bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts            |  50 +++++++++++++++++++++-
 3 files changed, 88 insertions(+), 3 deletions(-)
```

### Key diff hunks

**`src/store/card-store.ts` — `deleteCard` (interface + impl):**

```ts
// interface (after updateCard):
  /** 09-impl: hard-delete a card row by Card.id (md-wins reconciliation — the
   *  source md vanished). Also paired with deleteCardMdHash by the sweep. */
  deleteCard(id: string): Promise<void>;

// impl (on the store object, after updateCard impl):
    async deleteCard(id: string): Promise<void> {
      await runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          getDb().prepare("DELETE FROM memories WHERE md_id = ?").run(id);
        }),
      );
    },
```

**`src/walk-and-ingest.ts` — the dual-delete reconcile loop + call site:**

```ts
// imports (merged into the existing T3 import lines):
import {
  planningCardKindFromPath,
  parsePlanningPath,
  planningEffortId,
  planningTicketId,
} from "./store/planning-id.js";
import { planningContentHash, getStoredHash, upsertHash, deleteHash } from "./store/planning-sync-state.js";

// call site (step 8c, immediately after step 8b):
  // 8c. Planning delete reconciliation (Phase-2 / 09-impl) — md-wins sweep.
  await reconcilePlanningDeletions(walk.files.planning, opts.memoryDir);

// the helper (after mirrorPlanningToStore):
async function reconcilePlanningDeletions(
  presentPlanningFiles: string[],
  memoryDir?: string,
): Promise<{ planningDeleted: number }> {
  const presentIds = new Set<string>();
  for (const abs of presentPlanningFiles) {
    const info = parsePlanningPath(abs);
    if (!info) continue;
    presentIds.add(
      info.kind === "planning-effort" ? planningEffortId(info.effort) : planningTicketId(info.effort, info.ticketNo!),
    );
  }
  const dir = memoryDir ?? join(AGENT_ROOT, "pi-hermes-memory");
  const store = await createCardStore({ memoryDir: dir });
  let planningDeleted = 0;
  try {
    for (const kind of ["planning-effort", "planning-ticket"] as const) {
      const rows = await store.getCardsByKind(kind);
      for (const card of rows) {
        if (!presentIds.has(card.id)) {
          await store.deleteCard(card.id);   // (a) memories row
          await deleteHash(store, card.id);  // (b) card_md_hash row — together, no orphan
          planningDeleted++;
        }
      }
    }
  } finally {
    await store.close();
  }
  return { planningDeleted };
}
```

**`__tests__/walk-and-ingest.test.ts`** — appended the verbatim brief test
(`describe("walkAndIngest — planning delete reconciliation (09-impl T4)")`), with
the only deviation being the brief's NOTE: replaced `require("node:fs").unlinkSync(t02)`
with `unlinkSync(t02)` and added `unlinkSync` to the file's existing `node:fs` import.

## TDD evidence

### RED (before implementation) — `bun test __tests__/walk-and-ingest.test.ts`

```
AssertionError: Expected values to be strictly deep-equal:
+ actual - expected

  [
    'planning-ticket:recon-del:01',
+   'planning-ticket:recon-del:02'
  ]
(fail) walkAndIngest — planning delete reconciliation (09-impl T4) > hard-deletes planning rows whose source md vanished (md-wins)
 9 pass
 1 fail
Ran 10 tests across 1 file.
```

Right reason: ticket 02's memories row persists as an orphan after its source md
vanished (08's mirror never deletes; no sweep exists yet).

### GREEN (after implementation) — `bun test __tests__/walk-and-ingest.test.ts`

```
(pass) walkAndIngest — planning delete reconciliation (09-impl T4) > hard-deletes planning rows whose source md vanished (md-wins) [11.17ms]
10 pass
0 fail
Ran 10 tests across 1 file.
```

### Dual-delete verification (DoD: card_md_hash row gone, no orphan)

A throwaway verification (mirror 2 tickets, unlink one's md, re-walk, then query
`store.getCardMdHash` for both) confirmed:
```
hash row 01 (kept, expect present): present ✓ b915cef40a945009
hash row 02 (deleted, expect null): NULL ✓ (no orphan)
```
The committed test asserts the memories row is gone (verbatim from the brief);
this extra check confirms the brief's DoD that the `card_md_hash` row is also gone.

## Full-suite exact counts

```
( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )
```

- `bun run check` (`tsc --noEmit`): **clean** (zero errors).
- `bun test`: **1424 pass / 1 skip / 1 fail** across 122 files (1048 expect() calls).

vs. baseline-after-T3 = 1423 pass / 1 skip / 1 fail. The **+1 pass** is the new T4
test; **zero new failures**. The single failure is the known pre-existing ticket-04
time-bomb:

```
(fail) numeric isolation — assembled prompt never leaks memworth (UPSP §7 / DO ticket 04)
       > formatForSystemPrompt never emits memworth (memory + failure blocks — regression pin)
       at tests/store/memory-store.test.ts (~line 2630)
```

Untouched by this task (not in scope; carries explicitly per the baseline).

## Self-review

- **Dual-delete correctness:** `deleteCard` (memories row) + `deleteHash` (card_md_hash
  row) are issued as an atomic pair inside the same iteration for each vanished card.
  No code path deletes only the memories row → no orphaned hash rows. Verified
  empirically (above).
- **Mapping verbatim from the brief:** effort → `<effort>/map.md`, ticket →
  `<effort>/tickets/<no>-*.md`, derived via the existing `parsePlanningPath` (which
  reuses `planningCardKindFromSegs`). Present-id set built from `planningEffortId` /
  `planningTicketId` — the SAME canonical ids the mirror writes (T3), so the
  set-membership compare is exact.
- **Ordering:** sweep runs AFTER the mirror (8b) so an md that was just mirrored is
  in `presentIds` and survives; only truly-absent sources are deleted. The sweep also
  runs independently of the zk seam (planning is hermes-internal) — same property the
  mirror has.
- **Idempotency / re-runs:** a second walk with no further changes is a no-op for the
  sweep (the already-deleted card is gone from `memories`; `getCardsByKind` no longer
  returns it; the kept card is in `presentIds` → skipped). Confirmed by the existing
  T3 "skips an UNCHANGED ticket" test still passing alongside the new T4 test.
- **Store lifecycle:** the sweep opens/closes its own `createCardStore` (same shape as
  `mirrorPlanningToStore` / `mirrorVaultMdToStore`), with `finally { await store.close() }`
  — no handle leak on early return or throw.
- **Receipt discipline:** `WalkAndIngestReceipt` type and BOTH returns are unchanged —
  `planningDeleted` lives only on the helper's return, exactly as the brief and the
  ambiguity resolution required.
- **Scope discipline:** exactly 3 files staged by explicit path; the `.planning/.../sdd/`
  scratch + stashed `mlx_native.py` were never touched (still `??` after commit).
  One commit, message verbatim per the task instruction.

## Concerns

None. The implementation matches the brief verbatim (signature, mapping, call-site
step number, receipt non-change), the dual-delete is provably orphan-free, and the
full suite shows zero new failures.
