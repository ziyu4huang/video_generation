---
type: grilling
blocked by: [00-md-identity-model]
claimed: pi (wayfinder what-s-to-do-next, 2026-08-01)
status: closed
resolved: 2026-08-01
---

## Question

SQLite ids are **autoincrement integers**; Surreal ids are **record-ids** (`table:⟨id⟩`). Does the `.md` stable id need to be **backend-agnostic** (a separate portable field, identical shape on both backends) or does `.md` carry the **DB-native id** (different shape per backend)? This decides whether a `.md` vault is movable across backends and how read-back matching keys work.

## Why

5c/5b both maintain **dual-backend parity** (SQLite + Surreal contract tests). If the `.md` id is DB-native, the same `.md` file means different things on each backend and vault portability dies; if it's a portable synthetic field, the DB gains a new indexed column (`md_id`) that both backends must store and match on. The retire-the-bridge ticket (04) depends on this — id-based matching has to work on *both* backends.

## First takeable step

After 00 resolves, grill:

1. **Agnostic vs native** — is cross-backend / cross-machine `.md` portability a real requirement (see the Not-yet-specified portability fog), or is a vault permanently bound to one backend?
2. If agnostic: what's the new DB column + index on both backends (`md_id TEXT UNIQUE`?), and how does it coexist with the existing primary key?
3. If native: document the lock-in and how a future backend migration would remap ids.

Recommendation leans **agnostic** (a portable `md_id`) — it preserves the "`.md` is the movable source of truth" property the system already relies on, at the cost of one indexed column. But confirm portability is actually wanted before paying for it.

## Resolution (2026-08-01)

**Decision: agnostic.** The `.md` stable id (uuid v4, per ticket 00) is a **portable field the DB also stores** — it is *not* DB-native. Q1 (this grilling) settled agnostic-vs-native in favor of agnostic; the rest is determined by the existing schema (verified in `store/sqlite/schema.ts` + `store/surreal/schema.ts`), not a new decision:

- **md_id is necessarily secondary, not the PK.** On SQLite the PK is `id INTEGER PRIMARY KEY AUTOINCREMENT` — load-bearing for the `memory_fts` external-content `rowid` and the `supersedes`/`superseded_by` lineage refs. On Surreal the PK is the record-id `memories:⟨n⟩` (from the `seq` counter). md_id cannot replace either.
- **Shape:**
  - SQLite: `ALTER TABLE memories ADD COLUMN md_id TEXT` + `CREATE UNIQUE INDEX idx_memories_md_id ON memories(md_id)`.
  - Surreal: `md_id` field (table is `SCHEMALESS`) + `DEFINE INDEX md_id ON TABLE memories FIELDS md_id UNIQUE`.
- **Lineage stays DB-only** (per the destination): `supersedes` / `superseded_by` / `parent_ids` keep referencing the DB id; md_id is used **only** for the DB↔.md join that retires the content-key bridge (ticket 04). The `.md` vault is movable across backends and across machines (uuid is synthetic) — this also clears the **Cross-vault id portability** fog in the map's Not-yet-specified.

**Defers to ticket 01 (backfill & migration):** the md_id nullability timeline — nullable-during-lazy-backfill vs `NOT NULL` after an eager one-shot pass — is 01's lazy-vs-eager call, not 02's.

**Implementation-plan verification item (not a decision):** confirm SurrealDB's `UNIQUE` index permits multiple `NONE`/absent values during the backfill window (so un-backfilled rows don't collide), mirroring SQLite's NULLs-are-distinct behavior.
