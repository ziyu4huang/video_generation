---
type: grilling
blocked by: [00-md-identity-model, 01-backfill-and-migration, 02-dual-backend-id-reconciliation]
claimed: pi (wayfinder, 2026-08-01)
status: closed
resolved: 2026-08-01
---

## Question

Once the stable id lands, **retire 5b's content-key bridge**: replace content-based matching in `syncEvictions` / `removeExactSyncedMemories` (and any other content-key join) with **id-based matching**. Decide: full replacement, or retain content-key as a **dedup fallback** (and if so, for which path)? And what's the **migration path** so no in-flight 5b evictions are lost during the cutover?

## Why

This is the **destination ticket** — retiring the fragile content-key bridge (dup ambiguity + content-edit breakage) is why 5d exists. It waits on the identity model (00) and the backend shape (02): id-based matching only works once ids exist *and* are joinable on both backends. Note: if 00 picks a **content-hash** id, the id *is* the content-key and this ticket largely *moots* (they converge) — that's a valid resolution, recorded here, not a failure.

## First takeable step

After 00 + 02 resolve, grill:

1. **Full replace vs fallback** — does any path still *need* content matching (e.g., detecting a literal duplicate body, independent of identity)? If yes, keep content-key as a narrow dedup signal, id for everything else.
2. **Cutover safety** — during the window where backfill (01) hasn't touched every entry yet, what does matching do for an id-less entry? (Graceful fallback to content-key, then hard-switch once backfill completes?)
3. **Removal scope** — enumerate every content-key call site (`syncEvictions`, `removeExactSyncedMemories`, dedup, near-dup) and mark each replace/keep.

Resolution records the retire decision + migration path; this clears the way to `writing-plans` for the 5d implementation (the map's exit).

## Resolution (2026-08-01)

**Q1 = FULL REPLACE.** Content-key is **retired entirely** from the steady-state DB↔.md bridge — `md_id` becomes the only join key. The dup-ambiguity + content-edit-breakage fragility 5d exists to kill does not resurface. (Ticket 00 chose uuid, not content-hash, so the id ≠ content-key — this ticket does real work, it does not moot.)

**Q2 (cutover) — determined by ticket 01's eager backfill:** the eager one-shot IS the cutover. After the pass every entry has `md_id`; new entries get uuid at creation; legacy entries backfilled on startup. **No id-less stragglers in steady state** → no fallback needed, and no long dual-path window.

**Q3 (removal scope) — call sites mapped:**
- `removeExactSyncedMemories` (the shared content-key primitive) → replace its internals with `md_id` match. This covers **all callers**: the `syncEvictionsFromSqlite` helper (`memory-tool.ts`, invoked for `evicted_entries` + `offloaded_superseded`) and the `syncEvictions` helper (`review-memory-ops.ts`, same two paths), plus the `transfer` call site (`memory-tool.ts`).
- The store's `.md`-side content-key purge (`index.ts:362`, the store purging `.md` entries by content) → id-based.
- **The backfill (ticket 01) is the SOLE transient content-key user** — it matches `.md`→DB by content-key during the migration pass (rows lack `md_id` until touched) — retired once the pass completes.
- The unrelated content/dedup features (capture-throttle LRU #854, grill-decision threshold, supersede-content dedup, near-dup similarity) are **out of scope** — not the bridge.

**Migration path (no in-flight 5b evictions lost):** the eager backfill assigns `md_id` to every entry (mirroring to existing DB rows via content-key during the pass); steady-state eviction/offload/transfer matching then switches to `md_id`. Evictions occurring *during* the pass still use content-key (still valid); *after* the pass, `md_id`. Atomic per the eager pass — nothing orphaned.

**Exit:** this was the destination ticket. With 04 closed the 5d map is complete (7/7) → `/wayfind done` → `writing-plans` for the 5d implementation.
