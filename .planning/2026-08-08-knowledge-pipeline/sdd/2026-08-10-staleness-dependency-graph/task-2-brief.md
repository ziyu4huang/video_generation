# Task 2 Brief — `card_dep_hash` table: DDL + idempotent migration + CardStore accessors (10-impl T2)

> The "what I agreed to build" record. Extracted from the plan's `### Task 2:`
> section, with pre-implementation adjustments recorded where the real source
> diverged from (or confirmed) the plan.
>
> Plan: `.planning/2026-08-08-knowledge-pipeline/plans/2026-08-10-staleness-dependency-graph.md` (Task 2).
> Branch: `knowledge-pipeline/10-impl-staleness` (CONTINUED — branch was created at T1, NOT rebased/switched).
> Base SHA: `206475f006bbfef63dbdabef345efbe4531bedfa` (the T1 commit, already on the branch).

## Scope

T2 = the **staleness baseline storage layer**. A NEW additive `card_dep_hash`
table that holds ONE aggregate dep-hash row per planning card. SEPARATE from
09's `card_md_hash` (whose `card_id` is the SOLE PRIMARY KEY, already taken by
the mirror hash — see decision α). This is the table T3 (dep-aggregate-hash
writer) writes to and T4 (staleness compute) reads from. It mirrors 09-impl's
`card_md_hash` pattern EXACTLY for a new table: DDL in `SCHEMA_SQL` + an
idempotent `ensureCardDepHashTable` migration + three `CardStore` accessors.

## Files

- **Modify:** `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/schema.ts` — append `card_dep_hash` CREATE TABLE + index to `SCHEMA_SQL`, immediately after the `card_md_hash` / `idx_card_md_hash_kind` block.
- **Modify:** `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-backend.ts` — add private `ensureCardDepHashTable(db)` next to `ensureCardMdHashTable`; call it in `initializeSchema` right after `this.ensureCardMdHashTable(db);`.
- **Modify:** `bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts` — add `getCardDepHash` / `upsertCardDepHash` / `deleteCardDepHash` to the `CardStore` interface + the `store` impl.
- **Modify:** `bun-apps/pi-agent-ext-hermes-memory/__tests__/card-store.test.ts` — fresh-DB + legacy-DB table tests + accessor round-trip (mirror the existing 09 `card_md_hash` tests).

## Interfaces

- **Produces:** a new `card_dep_hash` table present on every DB (fresh + legacy), created idempotently (`CREATE TABLE IF NOT EXISTS`).
- **Produces (CardStore):**
  - `getCardDepHash(cardId): Promise<{ depHash: string; validatedAt: string } | null>`
  - `upsertCardDepHash(cardId: string, depHash: string): Promise<void>` — `INSERT … ON CONFLICT(card_id) DO UPDATE`; `validated_at = today()`
  - `deleteCardDepHash(cardId: string): Promise<void>` — `DELETE FROM card_dep_hash WHERE card_id = ?`
- **kind-less** — this table holds ONE aggregate row per card; NO `kind`
  discriminator (unlike `card_md_hash`, which carries `kind` for the mirror
  hash). The 2-arg `upsertCardDepHash` (no `kind`) reflects this.

### DDL (canonical — appended to `SCHEMA_SQL` AND ensured by the migration)

```sql
CREATE TABLE IF NOT EXISTS card_dep_hash (
  card_id TEXT PRIMARY KEY,
  dep_hash TEXT NOT NULL,
  validated_at DATE NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_dep_hash ON card_dep_hash(card_id);
```

## Steps (TDD)

1. **RED — write failing tests first.** Append to `__tests__/card-store.test.ts` inside the existing top-level describe (mirror the `card_md_hash` tests, same `RawDatabase` dynamic-import idiom):
   - `card_dep_hash` exists on a fresh store open.
   - `card_dep_hash` ensured on a legacy (pre-T2) DB via `ensureCardDepHashTable` (seed memories + `card_md_hash`, no `card_dep_hash`; open store; assert table present).
   - accessor round-trip: `getCardDepHash` null → `upsertCardDepHash` → `getCardDepHash` returns `{depHash, validatedAt}`; UPSERT overwrites; `deleteCardDepHash` → null.
2. Run tests → FAIL (`card_dep_hash` table absent; `getCardDepHash` not on CardStore).
3. **GREEN — impl.** DDL in `schema.ts` (after `idx_card_md_hash_kind`); `ensureCardDepHashTable` + call in `sqlite-backend.ts` (after `ensureCardMdHashTable`); the 3 accessors in `card-store.ts` (interface + impl, after the `card_md_hash` accessors).
4. Run tests → PASS.
5. Full-package `bun run check` + `bun test` → green. Expected after-T2 = after-T1 baseline (1449 pass / 1 skip / 1 fail) + (3 new tests) pass, same 1 skip / 1 known-fail (date-aging time-bomb) UNCHANGED.

## DoD

`card_dep_hash` exists on fresh + legacy DBs; `memories` + `card_md_hash` schemas byte-identical (additive table only — the α reassurance); the 3 accessors round-trip; full suite green.

## Contract decision (α — pinned)

NEW additive `card_dep_hash(card_id TEXT PK, dep_hash TEXT NOT NULL, validated_at DATE NOT NULL)` table — ONE aggregate row per card. NOT in `card_md_hash`: that table's `card_id` is the SOLE PRIMARY KEY (verified in `src/store/sqlite/schema.ts`), so a second `kind='validated'` row for the SAME card would COLLIDE on the PK. The new table is additive (`CREATE TABLE IF NOT EXISTS`, like 09's T1) → no migration to `card_md_hash`/`memories`.

---

## Pre-implementation adjustments (after reading the real source)

**A — `today()` already imported in `card-store.ts`.** Verified `import { today } from "./memory-format.js";` at line 33 — the upsert accessor uses it directly; no new import needed.

**B — `RawDatabase` is the dynamic-import idiom.** The 09 tests use `const { RawDatabase } = await import("../src/store/sqlite/sqlite-backend.js");` for raw `sqlite_master` inspection. T2 mirrors this verbatim (the test file also imports `Database` from `bun:sqlite` at the top, but the new tests use `RawDatabase` for parity with the 09 precedent).

**C — Existing `card_md_hash` DDL comment is now slightly stale (NOT fixed here).** The `card_md_hash` block's comment in `schema.ts` (lines ~134–136) says "'kind' discriminator so 10-impl can add dep-validation hashes (kind='validated') WITHOUT a migration." Decision α corrects this: the `card_id` SOLE-PK makes a `kind='validated'` row infeasible (PK collision), so 10-impl uses a NEW table. That existing comment is OUT OF T2 SCOPE to edit (additive-only mandate: `card_md_hash` byte-identical); the new `card_dep_hash` block carries its own corrected rationale. Noted for traceability; no action in T2.

**D — Legacy-migration test seeds `card_md_hash` too.** The plan's legacy test creates BOTH `memories` (6-value target CHECK) AND `card_md_hash` (post-09 shape) to represent a realistic "post-09 / pre-10" DB, then asserts `card_dep_hash` appears after store open. This is faithful to the real migration ordering (`initializeSchema` runs `ensureCardMdHashTable` then `ensureCardDepHashTable`); mirrored verbatim from the plan.
