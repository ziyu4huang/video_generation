---
type: grilling
blocked by: [02-dual-backend-id-reconciliation]
claimed: pi (wayfinder, 2026-08-01)
status: closed
resolved: 2026-08-01
---

## Question

Existing `.md` entries have **no id** *and* are in the **legacy HTML-comment format**. Backfill now does double duty: assign a `crypto.randomUUID()` id **and** rewrite each touched entry to **YAML frontmatter** (per ticket 00's lazy-migration decision), idempotently — a re-run never double-assigns, never changes an id once given, never rewrites an already-frontmatter entry, and never orphans an existing DB row from its `.md` line.

## Why

5d ships into a vault that already has many entries (and a DB with status/lineage for them). A broken backfill severs the DB↔.md link for exactly the entries 5b's content-key bridge currently holds together — a regression worse than the fragility we're fixing. The identity model (00) fixed *how* (uuid) and *where* (frontmatter); this ticket decides the backfill transform's idempotency, ordering, and DB-row coupling. The frontmatter rewrite rides free on the per-entry touch backfill was already doing.

## First takeable step

After 05 (schema) + 06 (parser) resolve, grill:

1. **Assignment trigger** — lazy (assign + rewrite on next read/write) vs eager (one-shot migration pass over the whole vault)? Recommendation: **eager one-shot** is safe here *because* it's idempotent (see below) and the vault is small; lazy leaves a long mixed-format window.
2. **Idempotency invariant** — "never overwrite a present id"; "never rewrite an entry already in frontmatter." A second run is a strict no-op. This is the proof that matters.
3. **DB-row coupling** — when a backfilled `.md` id meets an existing DB row for the first time, which side wins, and how is the join validated (the row currently has no `.md`-id column to match — ties to ticket 02)?
4. **Failure/rollback** — if backfill dies mid-vault, is the partial state recoverable (every successfully-rewritten entry is independently valid; resume skips frontmatter entries)?

## Resolution (2026-08-01)

**Q1 (trigger) = eager one-shot on startup, idempotent** — rides the `normalizeLegacyMemoryIds` one-time-migration pattern (`surreal-memory-repo.ts:683`): on startup, scan for legacy (non-frontmatter / id-less) `.md` entries; assign uuid + rewrite to frontmatter for each; populate the matched DB row's `md_id` in the same pass. Re-runs are a strict no-op. The rest follows from this + prior tickets + the verified bridge:

- **md_id nullability (resolves ticket 02's deferral):** nullable *during* the pass (no row has `md_id` until touched); trends to `NOT NULL` after completion, with a 1-release safety net before enforcing (mirrors ticket 06's legacy-read-path retirement pattern).
- **Idempotency invariant:** detection = "entry is frontmatter **and** has `id`" → skip; **never overwrite a present id** (immutability, ticket 00); never rewrite an already-frontmatter entry; never orphan an existing DB row from its `.md` line.
- **DB-row coupling:** during the pass, match `.md`→DB row by **content-key** (the existing bridge, since rows lack `md_id` yet); assign a **new** uuid; write it to **both** the `.md` frontmatter **and** the DB row's `md_id` — neither side "wins," the uuid is freshly minted and mirrored.
- **Failure/rollback:** per-entry — `.md` rewritten atomically (temp+rename, the existing safe-write); each rewritten entry is independently valid (frontmatter+id is self-contained); resume skips done entries (idempotent detection); if `.md` is rewritten but the DB `md_id` write dies, the idempotent re-run re-matches by content-key and completes.
- **Edge case — content-key dup during backfill** (two `.md` entries, identical stripped content): backfill assigns each a **distinct uuid**; the dup itself is resolved by dedup *after* backfill. The ambiguity md_id exists to fix does not block the backfill.
- **Edge case — `.md` entry with no matching DB row:** uuid still assigned to `.md` now; the DB row is created on the next sync/indexing pass (the entry simply hadn't been indexed yet).

**Feeds ticket 04 (retire content-key bridge):** after the eager pass, every entry has `md_id`, so 04 can replace content-key matching with id-based matching on a clean "everything has `md_id`" state — no prolonged dual-path window.
