# Task 2 Report — `card_dep_hash` table: DDL + idempotent migration + CardStore accessors (10-impl T2)

TDD audit-trail artifact. Mirrors the 09-impl / T1 `task-1-report.md` shape.

- **Branch:** `knowledge-pipeline/10-impl-staleness` (CONTINUED — not created/rebased/switched)
- **Base SHA (before T2):** `206475f006bbfef63dbdabef345efbe4531bedfa` (the T1 commit, already on the branch)
- **Commit:** `feat(knowledge-pipeline): card_dep_hash table + accessors (10-impl T2)` — SHA recorded in REPORT BACK summary (not self-referentially here).
- **Plan:** `.planning/2026-08-08-knowledge-pipeline/plans/2026-08-10-staleness-dependency-graph.md` § Task 2.
- **Brief:** `.planning/2026-08-08-knowledge-pipeline/sdd/2026-08-10-staleness-dependency-graph/task-2-brief.md`.

## What was implemented

The staleness **baseline storage layer**: a NEW additive `card_dep_hash` table
(ONE aggregate dep-hash row per planning card) + an idempotent migration +
three `CardStore` accessors. SEPARATE from 09's `card_md_hash` (whose `card_id`
is the SOLE PRIMARY KEY, taken by the mirror hash — decision α). Mirrors the
09-impl `card_md_hash` pattern byte-faithfully for a new table. This is the
storage that T3 (dep-aggregate-hash writer) writes to and T4 (staleness compute)
reads from.

1. **DDL** (`schema.ts`) — `card_dep_hash(card_id TEXT PK, dep_hash TEXT NOT NULL, validated_at DATE NOT NULL)` + `idx_card_dep_hash` appended to `SCHEMA_SQL` immediately after the `idx_card_md_hash_kind` index. **kind-less** (one aggregate row per card — no `kind` discriminator, unlike `card_md_hash`).
2. **Migration** (`sqlite-backend.ts`) — `ensureCardDepHashTable(db)` (private, `CREATE TABLE IF NOT EXISTS` + index; idempotent, no data to carry), called in `initializeSchema` immediately AFTER `this.ensureCardMdHashTable(db);`.
3. **Accessors** (`card-store.ts`, interface + impl) — `getCardDepHash` / `upsertCardDepHash` (2-arg, no `kind`) / `deleteCardDepHash`, same `runWithTransientRetry(() => backend.withCorruptionRecovery(() => …))` envelope as the `card_md_hash` accessors; `validated_at = today()` (already imported).

## Files changed (4, +127 / −0, purely additive)

```
 .../__tests__/card-store.test.ts                   | 56 ++++++++++++++++++++++
 .../src/store/card-store.ts                        | 41 ++++++++++++++++
 .../src/store/sqlite/schema.ts                     | 12 +++++++
 .../src/store/sqlite/sqlite-backend.ts             | 18 +++++++
 4 files changed, 127 insertions(+)
```

### Impl hunks

`schema.ts` (+12) — appended after `idx_card_md_hash_kind`:
```sql
  -- 10-impl (knowledge-pipeline / ticket 10): per-card aggregate hash of a
  -- planning-card's cited+declared source-file deps (the staleness baseline).
  -- SEPARATE from card_md_hash because that table's card_id is the SOLE PK
  -- (taken by the mirror hash) — a kind='validated' row there would collide.
  -- ONE aggregate row per card (no kind discriminator).
  CREATE TABLE IF NOT EXISTS card_dep_hash (
    card_id TEXT PRIMARY KEY,
    dep_hash TEXT NOT NULL,
    validated_at DATE NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_card_dep_hash ON card_dep_hash(card_id);
```

`sqlite-backend.ts` (+18) — `initializeSchema` call site (after `ensureCardMdHashTable`):
```ts
    this.ensureCardMdHashTable(db);
    // Phase-2 (knowledge-pipeline / ticket 10): ensure the card_dep_hash table
    // for the staleness dependency-graph baseline. Idempotent (CREATE TABLE IF
    // NOT EXISTS). Additive — does NOT touch memories/card_md_hash.
    this.ensureCardDepHashTable(db);
    this.rebuildMemoryFts(db);
```
… and the private method (added immediately after `ensureCardMdHashTable`):
```ts
  /** 10-impl (ticket 10): ensure the `card_dep_hash` table exists. Idempotent
   *  (CREATE TABLE IF NOT EXISTS). Additive — does NOT touch `memories` or
   *  `card_md_hash` (no C3 column-drift; no PK collision with the mirror hash). */
  private ensureCardDepHashTable(db: DatabaseLike): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS card_dep_hash (
        card_id TEXT PRIMARY KEY,
        dep_hash TEXT NOT NULL,
        validated_at DATE NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_card_dep_hash ON card_dep_hash(card_id);
    `);
  }
```

`card-store.ts` (+41) — interface (3 accessors after `deleteCardMdHash`) + impl (after the `deleteCardMdHash` impl, before `async close()`):
```ts
    getCardDepHash(cardId: string): Promise<{ depHash: string; validatedAt: string } | null> {
      return runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          const row = getDb()
            .prepare("SELECT dep_hash, validated_at FROM card_dep_hash WHERE card_id = ?")
            .get(cardId) as { dep_hash: string; validated_at: string } | undefined;
          return row ? { depHash: row.dep_hash, validatedAt: row.validated_at } : null;
        }),
      );
    },

    upsertCardDepHash(cardId: string, depHash: string): Promise<void> {
      return runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          getDb()
            .prepare(
              `INSERT INTO card_dep_hash (card_id, dep_hash, validated_at)
               VALUES (?, ?, ?)
               ON CONFLICT(card_id) DO UPDATE SET
                 dep_hash = excluded.dep_hash,
                 validated_at = excluded.validated_at`,
            )
            .run(cardId, depHash, today());
        }),
      );
    },

    deleteCardDepHash(cardId: string): Promise<void> {
      return runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          getDb().prepare("DELETE FROM card_dep_hash WHERE card_id = ?").run(cardId);
        }),
      );
    },
```

`__tests__/card-store.test.ts` (+56) — 3 new tests inside the existing top-level describe (mirror the `card_md_hash` tests): (a) `card_dep_hash` exists on a fresh store open; (b) `card_dep_hash` ensured on a legacy (pre-10) DB (seed `memories` + `card_md_hash`, open store, assert table present); (c) accessor round-trip (null → upsert → read → UPSERT overwrite → delete → null).

## TDD evidence

### RED (Step 2)

Command: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/card-store.test.ts )`
Result: **3 fail / 8 pass.**

- 2 table-existence tests fail with `AssertionError: actual: undefined, expected: "card_dep_hash"` (table does not exist yet).
- accessor round-trip fails with `TypeError: store.getCardDepHash is not a function` (accessor not on CardStore yet).
- **Why expected:** the table DDL, the migration, and the accessors did not yet exist — exactly the surface T2 adds. The 8 pre-existing tests (incl. both `card_md_hash` tests) stayed green.

### GREEN (Step 6)

Command: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/card-store.test.ts )`
Result: **11 pass / 0 fail** (8 pre-existing + 3 new).

## Full-suite regression (Step 7)

Command: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`

- `bun run check` (`tsc --noEmit`): **clean** (no output).
- `bun test`:

| Suite | pass | skip | fail | note |
|-------|------|------|------|------|
| after-T1 baseline | 1449 | 1 | 1 | the known date-aging time-bomb |
| **after-T2** | **1452** | **1** | **1** | +3 new tests pass; skip + the 1 known-fail UNCHANGED |
| **net delta** | **+3** | **0** | **0** | purely additive |

The single failure is `tests/store/memory-store.test.ts > formatForSystemPrompt never emits memworth …` — the **pre-existing date-aging time-bomb** (uses `dateDaysAgo` / `new Date()` / hardcoded `2026-08-01`). Verified it is NOT a T2 regression: that test file has **zero references** to `card_dep_hash`, `card_md_hash`, `card-store`, `sqlite-backend`, or `schema` (grep-confirmed). Identical to the T1 baseline's 1 known-fail.

## Self-review (additive-only confirmation — the α reassurance)

- **`memories` UNCHANGED** — T2 adds no column, no CHECK change, no rebuild. The only `memories`-adjacent migration (`migrateMemoriesTargetCheckAddPlanning`) is pre-existing and not touched. Verified: the `git diff` for `schema.ts` shows ONLY the new `card_dep_hash` block appended; the `memories` CREATE TABLE / indexes / `idx_memories_*` are byte-identical.
- **`card_md_hash` UNCHANGED** — its CREATE TABLE, `idx_card_md_hash_kind` index, `ensureCardMdHashTable` migration method, its `initializeSchema` call site, and all three `card_md_hash` accessors are byte-identical. The two 09 `card_md_hash` tests still pass unchanged. The `git diff` for `sqlite-backend.ts` shows the new call inserted AFTER `ensureCardMdHashTable(db);` (not replacing it), and the new method AFTER `ensureCardMdHashTable`'s closing brace (not inside it).
- **Additive = +127 / −0** — no deletion in any of the 4 files; every hunk is a pure append/insert.
- **kind-less by design** — the new table has NO `kind` column (one aggregate row per card), so there is no PK collision with `card_md_hash`'s mirror row. This is the corrected decision α (the `card_md_hash` block's stale comment forecasting `kind='validated'` is out of T2 scope to edit — noted in the brief, Adjustment C).

## Deviations from the plan's T2 code

**None.** The DDL, the migration method, the `initializeSchema` call ordering, the three accessor signatures + impls, and the three tests are byte-faithful to the plan's Task 2 section. The only delta is the `schema.ts`/method doc-comments, which carry the corrected decision-α rationale (SEPARATE table because `card_id` SOLE-PK collides) rather than the 09-impl "kind discriminator" framing — and those comments are themselves within the NEW `card_dep_hash` block (no edit to the existing `card_md_hash` comment).

## Concerns

None. T2 is the storage layer; its only consumers (T3 writer, T4 reader) land in subsequent tasks. The table is created on every open (fresh + legacy), is idempotent, and round-trips correctly. The additive-only invariant holds.
