# .planning DB↔md sync — Implementation Plan (Phase-2 / 09-impl)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `.planning` card-store mirror **self-correcting** — keep the DB mirror aligned with git-canonical `.planning` md via content-hash drift detection (Tier-1, md-wins): re-mirror changed cards, delete rows whose source md vanished, flag efforts with unresolved merge conflict markers, on-demand refresh + background backfill. Built on top of 08-impl's planning-card model + append-once mirror. **No git hooks.**

**Architecture:** A new `card_md_hash` table (`card_id` PK → `content_hash` + `mirrored_at` + `kind`, default `'mirror'`) is the single home for content-hash state. It houses BOTH 09's mirror hashes (`kind='mirror'`) AND, later, 10's dep-validated hashes (`kind='validated'`) — **one table, `kind` discriminator (the 09→10 handoff)**. The planning mirror (`mirrorPlanningToStore`) computes the incoming card's content-hash (reusing `merge-plan.ts:hashEntry`), reads the stored hash, and branches:

- **no stored hash** → INSERT the card (`upsertCard`) + write the hash;
- **hash mismatch** → UPDATE the card's `content`/`frontmatter`/`last_referenced` (NEW `store.updateCard`) + refresh the hash;
- **hash match** → skip (no write).

Dedup strategies stay **PURE identity** (keep-new / skip-dup) — staleness lives in the **sync layer**, not dedup (the `DedupDecision.action` union is `"keep"|"merge"|"skip"` — no `"update"`, by design). A reconciliation sweep hard-deletes planning rows whose source md is absent (md-wins). Conflict-marker detection scans md bytes (reusing the `git-ops` merge-marker idiom) and flags the effort for human review — surfaced in the ingest receipt as `conflictMarkerEfforts: string[]` (NOT a `stale:`/`conflict:` query; that's 10). Background backfill mirrors `session-backfill.ts` house-style (on `session_start`, `MAX_FILES` bound, run-state). On-demand refresh is EXPLICIT (`refreshPlanningCard(id)`) — regular `getCard`/`getCardsByKind` return the DB row as-is (fast; NO re-hash on every read, avoiding O(n) file reads per query).

**Tech Stack:** Bun (no build step), TypeScript (`bun run check` — this package's `tsc --noEmit`), `node:test` + `node:assert/strict`, `yaml` (frontmatter), bun:sqlite (via `SqliteBackend`), `@repo/pi-agent-ext-hermes-memory`.

## Global Constraints

- Platform: Apple Silicon, Bun (no build step; `bun run check` for type-checking).
- Workspace: `bun-apps/` root with isolated linker — every imported package MUST be a declared dep of the importing package.
- NEVER use a top-level `cd` — use `( cd <dir> && ... )` or `git -C <WT>` / `--cwd`.
- **Master invariant:** `.planning` md stays **git-canonical** — 09 NEVER writes md (read-only mirror). memory/user/failure/knowledge cards MUST NOT regress: 09 changes 08-impl's append-once *behavior* (now update/delete) but does NOT semantically regress 08's FILES (`planning-id`/`planning-parse`/`planning-serializer`/`planning-dedup` unchanged — dedup stays pure identity). `card_md_hash` is an **ADDITIVE new table** → no `memories` rebuild → no C3 column-drift trap (the `memories` schema is UNCHANGED by 09). If any non-planning test breaks at a task boundary, **STOP and fix**.
- `<WT>` = the repo worktree root (the dir containing `bun-apps/` and `.planning/`). All `git -C <WT>` and `( cd ... )` calls use it.

## 09↔10 boundary (do NOT cross)

- **09 owns** mirror drift (hash-compare INSERT/UPDATE/skip) + delete reconciliation + conflict-marker flag (effort-level, for human review) + on-demand refresh + background backfill.
- **10 owns** `stale:` decision-staleness (card flag + query + graduation gate) + dep-validation (the `kind='validated'` rows) + the `conflict:` divergence query.
- **09 MUST NOT build** `stale:` / `conflict:` query / graduation gate / dependency-graph re-validation.
- **09's `card_md_hash` table (`kind` discriminator) is 10's hash-storage foundation** — design the schema so 10 can add `kind='validated'` rows WITHOUT a migration (the `kind` column + index already exist).

## Scope boundaries (deferred — NOT in this plan)
- Ticket 10 (staleness dependency graph + `stale:`/`conflict:` queries + graduation gate + dep-validation).
- Ticket 14 (semantic/embed search over planning-cards).
- Write-through sync; git-hook-triggered sync; DB-wins drift; tombstoning (09 hard-deletes); first-class `planning-decision` cards.

## Resolved decisions (from grill 2026-08-10 — recorded durably)

- **Hash storage:** dedicated `card_md_hash` table (NOT a `memories` column — avoids the C3 column-drift trap; `memories` schema UNCHANGED).
- **Update path:** sync-layer hash-compare + direct `UPDATE`; dedup stays pure identity.
- **Delete:** hard-delete the DB row (+ its hash row) when the source md is absent.
- **House style:** hash = `merge-plan.ts:hashEntry` (16-hex-char sha256; keyed by `card.id`); backfill = `session-backfill.ts` shape; conflict-markers = `git-ops` merge-marker idiom (file-bytes scan; see T5 note); refresh = explicit points + backfill, NEVER every-read-rehash.

---

### Task 1: `card_md_hash` table (schema DDL + idempotent migration)

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/schema.ts` (append the `card_md_hash` CREATE TABLE + index to `SCHEMA_SQL`)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-backend.ts` (add `ensureCardMdHashTable(db)`; call it in `initializeSchema`)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/__tests__/card-store.test.ts` (fresh-DB + legacy-DB table tests)

**Interfaces:**
- Produces: a new `card_md_hash` table present on every DB (fresh + legacy), created idempotently.
- DDL (canonical — appended to `SCHEMA_SQL` AND ensured by the migration):
  ```sql
  CREATE TABLE IF NOT EXISTS card_md_hash (
    card_id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    mirrored_at DATE NOT NULL,
    kind TEXT NOT NULL DEFAULT 'mirror'
  );
  CREATE INDEX IF NOT EXISTS idx_card_md_hash_kind ON card_md_hash(kind);
  ```

- [ ] **Step 1: Write the failing tests (append to `__tests__/card-store.test.ts`)**

Append inside the existing top-level describe block (or a new sibling describe — match the file's existing style):
```ts
  it("creates card_md_hash on a fresh store open (09-impl T1)", async () => {
    // A fresh createCardStore runs initializeSchema -> SCHEMA_SQL carries the
    // card_md_hash CREATE TABLE. SELECT against it must succeed (table exists).
    const cols = store
      ? await (async () => {
          // Re-open a raw handle to the SAME db file to inspect sqlite_master.
          const { RawDatabase } = await import("../src/store/sqlite/sqlite-backend.js");
          const raw = new RawDatabase(join(memoryDir, "sessions.db"));
          const row = raw
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='card_md_hash'")
            .get() as { name?: string } | undefined;
          raw.close();
          return row?.name;
        })()
      : undefined;
    assert.equal(cols, "card_md_hash");
  });

  it("ensures card_md_hash on a legacy (pre-09) DB via ensureCardMdHashTable", async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), "cardmdhash-migrate-"));
    try {
      // Seed a post-08 DB that has memories but NO card_md_hash (a pre-09 DB).
      const { RawDatabase } = await import("../src/store/sqlite/sqlite-backend.js");
      const raw = new RawDatabase(join(legacyDir, "sessions.db"));
      raw.exec(
        `CREATE TABLE memories (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           target TEXT NOT NULL CHECK (target IN ('memory','user','failure','knowledge','planning-effort','planning-ticket')),
           content TEXT NOT NULL, created DATE NOT NULL, last_referenced DATE NOT NULL
         )`,
      );
      raw.close();
      // Opening the store runs initializeSchema -> ensureCardMdHashTable fires
      // (CREATE TABLE IF NOT EXISTS) on the legacy DB that lacks it.
      const migrated = await createCardStore({ memoryDir: legacyDir, dbBackend: "sqlite" });
      await migrated.close();
      const after = new RawDatabase(join(legacyDir, "sessions.db"));
      const row = after
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='card_md_hash'")
        .get() as { name?: string } | undefined;
      after.close();
      assert.equal(row?.name, "card_md_hash");
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
```
> NOTE: `RawDatabase` is the exported bun:sqlite wrapper from `sqlite-backend.ts` (used by the existing T5 migration test in this same file — mirror its import idiom). `memoryDir` / `store` / `mkdtempSync` / `tmpdir` / `rmSync` are already in scope in `card-store.test.ts` (the T5 planning tests set them up).

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/card-store.test.ts )`
Expected: FAIL — `card_md_hash` table does not exist (`SELECT … name='card_md_hash'` returns undefined).

- [ ] **Step 3: Add the DDL to SCHEMA_SQL**

In `src/store/sqlite/schema.ts`, append IMMEDIATELY AFTER the `idx_memories_md_id` index block (before the `session_assembly` table) — keep it beside the `memories` apparatus it mirrors:
```sql
  -- 09-impl (knowledge-pipeline / ticket 09): content-hash state for the
  -- planning-card mirror (Tier-1, md-wins drift). `kind` discriminator so 10-impl
  -- can add dep-validation hashes (kind='validated') WITHOUT a migration.
  CREATE TABLE IF NOT EXISTS card_md_hash (
    card_id TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    mirrored_at DATE NOT NULL,
    kind TEXT NOT NULL DEFAULT 'mirror'
  );
  CREATE INDEX IF NOT EXISTS idx_card_md_hash_kind ON card_md_hash(kind);
```

- [ ] **Step 4: Add `ensureCardMdHashTable` + call it**

In `src/store/sqlite/sqlite-backend.ts`, add the private method (NEXT to `ensureMemoriesColumns` — same house style, but **simpler**: this is a NEW table so it's `CREATE TABLE IF NOT EXISTS`, NOT a rebuild — no data to carry, no column-list, no transaction):
```ts
  /** 09-impl (ticket 09): ensure the `card_md_hash` table exists. Idempotent
   *  (CREATE TABLE IF NOT EXISTS). Simpler than the T5 target-CHECK migrations
   *  (which rebuild `memories`): this is a brand-new table with no legacy rows,
   *  so there is nothing to carry through a rewrite. Fresh installs already get
   *  it from SCHEMA_SQL; this only fires for pre-09 DBs that predate the table. */
  private ensureCardMdHashTable(db: DatabaseLike): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS card_md_hash (
        card_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        mirrored_at DATE NOT NULL,
        kind TEXT NOT NULL DEFAULT 'mirror'
      );
      CREATE INDEX IF NOT EXISTS idx_card_md_hash_kind ON card_md_hash(kind);
    `);
  }
```
Then in `initializeSchema(db)`, add ONE line immediately AFTER the existing `this.migrateMemoriesTargetCheckAddPlanning(db);` call (the T5 sibling call site — `initializeSchema` already runs `ensureLegacySchemaColumns` / the three target-CHECK migrations / `rebuildMemoryFts` in order; append at the end of that sequence):
```ts
    // Phase-2 (knowledge-pipeline / ticket 09): ensure the card_md_hash table
    // for the planning-card content-hash mirror. Idempotent (CREATE TABLE IF
    // NOT EXISTS). Additive — does NOT touch `memories` (no C3 column-drift).
    this.ensureCardMdHashTable(db);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/card-store.test.ts )`
Expected: PASS (existing card-store tests + the 2 new table tests).

- [ ] **Step 6: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
Expected: all green (memory/user/failure/knowledge/planning unchanged).
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/schema.ts bun-apps/pi-agent-ext-hermes-memory/src/store/sqlite/sqlite-backend.ts bun-apps/pi-agent-ext-hermes-memory/__tests__/card-store.test.ts
git -C <WT> commit -m "feat(knowledge-pipeline): card_md_hash table — schema DDL + idempotent migration (09-impl T1)"
```

**DoD:** `card_md_hash` exists on fresh + legacy DBs; `memories` schema byte-identical (additive table only); full package suite green.

---

### Task 2: content-hash + sync-state accessor (pure hash + store accessors)

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.ts`
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.test.ts`
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts` (add `getCardMdHash` / `upsertCardMdHash` / `deleteCardMdHash` to the `CardStore` interface + impl)

**Interfaces:**
- Consumes: `Card` from `./card.js`; `hashEntry` from `./merge-plan.js`; `today` from `./memory-format.js`; `CardStore` (extended).
- Produces:
  - `planningContentHash(card: Card): string` — pure; `hashEntry(canonicalCardBytes(card))` (16-hex-char sha256).
  - `getStoredHash(store, cardId)` / `upsertHash(store, cardId, hash, kind='mirror')` / `deleteHash(store, cardId)` — thin wrappers over the new `CardStore` hash accessors.
  - `CardStore.getCardMdHash(cardId)` / `.upsertCardMdHash(cardId, hash, kind)` / `.deleteCardMdHash(cardId)` — the SQL-backed accessors.

**Canonical byte form (PINNED — the exact definition of "what is hashed"):**
```ts
/** Canonical byte form of a Card for content-hashing: a STABLE JSON serialization
 *  of the Tier-1 md-canonical fields (content + frontmatter) + a defensive `kind`.
 *  Frontmatter is a JSON object whose key order is NOT stable across runs, so keys
 *  are sorted recursively (stable stringify). Arrays (e.g. blockedBy) are left in
 *  serializer-determined order (PlanningTicketSerializer builds them deterministically
 *  via parseBlockedBy). Identical cards always hash identically; ANY content or
 *  frontmatter change changes the hash. */
function canonicalCardBytes(card: Card): string {
  return JSON.stringify({
    kind: card.kind,
    content: card.content,
    frontmatter: sortKeysDeep(card.frontmatter),
  });
}

/** Recursive key-sort for deterministic JSON (mirrors the stable-stringify idiom). */
function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeysDeep) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return out as unknown as T;
  }
  return value;
}

export function planningContentHash(card: Card): string {
  return hashEntry(canonicalCardBytes(card));
}
```

- [ ] **Step 1: Write the failing test**

Create `src/store/planning-sync-state.test.ts`:
```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planningContentHash, getStoredHash, upsertHash, deleteHash } from "./planning-sync-state.js";
import { createCardStore } from "./card-store.js";
import type { Card } from "./card.js";

const card = (overrides: Partial<Card> = {}): Card => ({
  id: "planning-ticket:e:01",
  kind: "planning-ticket",
  content: "body",
  frontmatter: { id: "01", slug: "x", status: "closed" },
  ...overrides,
});

describe("planningContentHash", () => {
  it("is deterministic for identical content + frontmatter", () => {
    assert.equal(planningContentHash(card()), planningContentHash(card()));
  });
  it("is 16 hex chars (hashEntry width)", () => {
    assert.match(planningContentHash(card()), /^[0-9a-f]{16}$/);
  });
  it("changes when content changes", () => {
    assert.notEqual(planningContentHash(card()), planningContentHash(card({ content: "edited" })));
  });
  it("is invariant to frontmatter key ORDER (stable stringify)", () => {
    const a = card({ frontmatter: { id: "01", slug: "x", status: "closed" } });
    const b = card({ frontmatter: { status: "closed", slug: "x", id: "01" } });
    assert.equal(planningContentHash(a), planningContentHash(b));
  });
  it("changes when a frontmatter VALUE changes", () => {
    assert.notEqual(
      planningContentHash(card()),
      planningContentHash(card({ frontmatter: { id: "01", slug: "x", status: "open" } })),
    );
  });
});

describe("card_md_hash round-trip (via CardStore accessors)", () => {
  const dir = mkdtempSync(join(tmpdir(), "planning-hash-rt-"));
  it("getStoredHash returns null when absent", async () => {
    const store = await createCardStore({ memoryDir: dir });
    try {
      assert.equal(await getStoredHash(store, "planning-ticket:e:01"), null);
    } finally {
      await store.close();
    }
  });
  it("upsertHash then getStoredHash round-trips (default kind='mirror')", async () => {
    const store = await createCardStore({ memoryDir: dir });
    try {
      await upsertHash(store, "planning-ticket:e:01", "abc123def456abcd");
      const got = await getStoredHash(store, "planning-ticket:e:01");
      assert.equal(got?.hash, "abc123def456abcd");
      assert.equal(got?.kind, "mirror");
      assert.ok(got?.mirroredAt);
    } finally {
      await store.close();
    }
  });
  it("upsertHash is idempotent UPSERT (re-write overwrites hash + mirrored_at)", async () => {
    const store = await createCardStore({ memoryDir: dir });
    try {
      await upsertHash(store, "planning-ticket:e:01", "firsthash0000000");
      await upsertHash(store, "planning-ticket:e:01", "secondhash0000000", "mirror");
      const got = await getStoredHash(store, "planning-ticket:e:01");
      assert.equal(got?.hash, "secondhash0000000");
    } finally {
      await store.close();
    }
  });
  it("deleteHash removes the row", async () => {
    const store = await createCardStore({ memoryDir: dir });
    try {
      await deleteHash(store, "planning-ticket:e:01");
      assert.equal(await getStoredHash(store, "planning-ticket:e:01"), null);
    } finally {
      await store.close();
    }
  });
  // Best-effort cleanup AFTER the round-trip suite shares one dir.
  after(() => rmSync(dir, { recursive: true, force: true }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-sync-state.test.ts )`
Expected: FAIL — `Cannot find module "./planning-sync-state.js"` (and `getCardMdHash` not on CardStore).

- [ ] **Step 3: Add the hash accessors to CardStore**

In `src/store/card-store.ts`, extend the `CardStore` interface (additive — after `serializerFor`):
```ts
  /** 09-impl: read the stored content-hash row for a card (by Card.id), or null. */
  getCardMdHash(cardId: string): Promise<{ hash: string; mirroredAt: string; kind: string } | null>;
  /** 09-impl: UPSERT a content-hash row (SQLite ON CONFLICT DO UPDATE). */
  upsertCardMdHash(cardId: string, hash: string, kind?: string): Promise<void>;
  /** 09-impl: delete the content-hash row for a card. */
  deleteCardMdHash(cardId: string): Promise<void>;
```
Implement them on the `store` object (same `runWithTransientRetry(() => backend.withCorruptionRecovery(() => …))` envelope as `getCard`/`upsertCard`):
```ts
    getCardMdHash(cardId: string): Promise<{ hash: string; mirroredAt: string; kind: string } | null> {
      return runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          const row = getDb()
            .prepare("SELECT content_hash, mirrored_at, kind FROM card_md_hash WHERE card_id = ?")
            .get(cardId) as { content_hash: string; mirrored_at: string; kind: string } | undefined;
          return row ? { hash: row.content_hash, mirroredAt: row.mirrored_at, kind: row.kind } : null;
        }),
      );
    },

    upsertCardMdHash(cardId: string, hash: string, kind = "mirror"): Promise<void> {
      return runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          getDb()
            .prepare(
              `INSERT INTO card_md_hash (card_id, content_hash, mirrored_at, kind)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(card_id) DO UPDATE SET
                 content_hash = excluded.content_hash,
                 mirrored_at = excluded.mirrored_at,
                 kind = excluded.kind`,
            )
            .run(cardId, hash, today(), kind);
        }),
      );
    },

    deleteCardMdHash(cardId: string): Promise<void> {
      return runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          getDb().prepare("DELETE FROM card_md_hash WHERE card_id = ?").run(cardId);
        }),
      );
    },
```

- [ ] **Step 4: Write the planning-sync-state module**

Create `src/store/planning-sync-state.ts`:
```ts
// src/store/planning-sync-state.ts — pure content-hash + thin sync-state accessors
// for the .planning card mirror (Phase-2 / ticket 09, Tier-1 md-wins drift).
//
// The DB SQL lives on CardStore (getCardMdHash/upsertCardMdHash/deleteCardMdHash,
// implemented in card-store.ts alongside all other memories/card SQL — the single
// SQL home). This module owns the PURE hash function (planningContentHash, reusing
// merge-plan.hashEntry) + the sync-layer wrappers the mirror/sweep/refresh code
// imports. Hash = 16-hex-char sha256 of canonicalCardBytes(card), keyed by Card.id.
import type { Card } from "./card.js";
import type { CardStore } from "./card-store.js";
import { hashEntry } from "./merge-plan.js";

/** See "Canonical byte form" in the plan: stable JSON of {kind, content, frontmatter}
 *  with recursively-sorted keys. Identical cards hash identically; any content or
 *  frontmatter change changes the hash. */
function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeysDeep) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return out as unknown as T;
  }
  return value;
}

function canonicalCardBytes(card: Card): string {
  return JSON.stringify({
    kind: card.kind,
    content: card.content,
    frontmatter: sortKeysDeep(card.frontmatter),
  });
}

/** Content-hash of a planning card (reuses merge-plan.hashEntry: sha256 → 16 hex). */
export function planningContentHash(card: Card): string {
  return hashEntry(canonicalCardBytes(card));
}

/** Read the stored mirror hash for a card, or null when none has been written. */
export async function getStoredHash(
  store: CardStore,
  cardId: string,
): Promise<{ hash: string; mirroredAt: string; kind: string } | null> {
  return store.getCardMdHash(cardId);
}

/** UPSERT the mirror hash for a card (default kind='mirror'; 10 uses 'validated'). */
export async function upsertHash(
  store: CardStore,
  cardId: string,
  hash: string,
  kind = "mirror",
): Promise<void> {
  await store.upsertCardMdHash(cardId, hash, kind);
}

/** Delete the hash row for a card (paired with hard-delete of the memories row). */
export async function deleteHash(store: CardStore, cardId: string): Promise<void> {
  await store.deleteCardMdHash(cardId);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-sync-state.test.ts )`
Expected: PASS.

- [ ] **Step 6: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
Expected: all green.
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.ts bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.test.ts bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts
git -C <WT> commit -m "feat(knowledge-pipeline): planning content-hash + sync-state accessors (09-impl T2)"
```

**DoD:** `planningContentHash` is deterministic (key-order-invariant), 16-hex; the 3 store accessors round-trip against `card_md_hash`; full suite green.

---

### Task 3: mirror UPDATE path (the core behavior change) + `store.updateCard`

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts` (add `updateCard` to the `CardStore` interface + impl)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts` (rewrite `mirrorPlanningToStore` to the hash-compare INSERT/UPDATE/skip)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts` (edited/unchanged/new ticket cases)

**Interfaces:**
- Produces:
  - `CardStore.updateCard(card): Promise<void>` — `UPDATE memories SET content=?, frontmatter=?, last_referenced=? WHERE md_id=?` (Tier-1 md-wins refresh; bypasses dedup, which is pure identity).
  - `mirrorPlanningToStore` now computes `planningContentHash(card)`, reads the stored hash, and branches INSERT(new)/UPDATE(mismatch)/skip(match). Returns `{ planningMirrored, conflictMarkerEfforts }` (the `conflictMarkerEfforts` field is populated in T5; here it stays `[]`).

- [ ] **Step 1: Write the failing tests (append to `__tests__/walk-and-ingest.test.ts`)**

Add a new describe block (imports `walkAndIngest`, `createCardStore`, `mkdtempSync`, etc. are already in scope from the 08-impl planning test):
```ts
describe("walkAndIngest — planning mirror drift (09-impl T3)", () => {
  it("INSERTs a new ticket (no stored hash)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pmir-ins-"));
    const mem = mkdtempSync(join(tmpdir(), "pmir-ins-mem-"));
    try {
      const effort = "drift-ins";
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      writeFileSync(join(root, ".planning", effort, "tickets", "01-x.md"),
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nFirst.\n");
      const r = await walkAndIngest(root, { memoryDir: mem });
      assert.ok(r.planningMirrored >= 1);
      const store = await createCardStore({ memoryDir: mem });
      const c = await store.getCard(`planning-ticket:${effort}:01`);
      await store.close();
      assert.match(c?.content ?? "", /First\./);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("UPDATEs an edited ticket (hash mismatch) instead of skipping", async () => {
    const root = mkdtempSync(join(tmpdir(), "pmir-upd-"));
    const mem = mkdtempSync(join(tmpdir(), "pmir-upd-mem-"));
    try {
      const effort = "drift-upd";
      const ticketPath = join(root, ".planning", effort, "tickets", "01-x.md");
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      writeFileSync(ticketPath,
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nOriginal.\n");
      await walkAndIngest(root, { memoryDir: mem });            // mirror once (INSERT + hash)
      // Edit the ticket content (git-canonical md changed).
      writeFileSync(ticketPath,
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nEDITED body.\n");
      const r2 = await walkAndIngest(root, { memoryDir: mem });  // re-mirror → UPDATE
      assert.ok(r2.planningMirrored >= 1, "edited ticket must be re-mirrored (UPDATE), not skipped");
      const store = await createCardStore({ memoryDir: mem });
      const c = await store.getCard(`planning-ticket:${effort}:01`);
      await store.close();
      assert.match(c?.content ?? "", /EDITED body\./);
      assert.doesNotMatch(c?.content ?? "", /Original\./);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("skips an UNCHANGED ticket (hash match — no write)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pmir-skip-"));
    const mem = mkdtempSync(join(tmpdir(), "pmir-skip-mem-"));
    try {
      const effort = "drift-skip";
      const ticketPath = join(root, ".planning", effort, "tickets", "01-x.md");
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      const body = "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nStable.\n";
      writeFileSync(ticketPath, body);
      await walkAndIngest(root, { memoryDir: mem });             // mirror once
      const r2 = await walkAndIngest(root, { memoryDir: mem });  // re-mirror unchanged
      assert.equal(r2.planningMirrored, 0, "unchanged ticket must be skipped (hash match)");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/walk-and-ingest.test.ts )`
Expected: FAIL — the "edited ticket" case fails (08's append-only mirror skips the existing id, so content stays "Original"); the "skipped" case fails (08's mirror reports `planningMirrored >= 1` on every re-ingest because it has no hash-skip).

- [ ] **Step 3: Add `store.updateCard`**

In `src/store/card-store.ts`, extend the `CardStore` interface (after `upsertCard`):
```ts
  /** 09-impl: Tier-1 md-wins refresh — UPDATE an EXISTING card's content +
   *  frontmatter (NOT a new row). Bypasses dedup (pure identity cannot express
   *  "update"; the sync-layer hash-compare decides WHEN to call this). */
  updateCard(card: Card): Promise<void>;
```
Implement on `store` (same retry/recovery envelope as `upsertCard`; the UPDATE keys off `md_id = Card.id`):
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

- [ ] **Step 4: Rewrite `mirrorPlanningToStore` to the hash-compare branch**

In `src/walk-and-ingest.ts`, add the import at the top (alongside the existing `planningCardKindFromPath` import):
```ts
import { planningContentHash, getStoredHash, upsertHash } from "./store/planning-sync-state.js";
```
Add `conflictMarkerEfforts` to the `mirrorPlanningToStore` return type and to the `WalkAndIngestReceipt` interface (field added in T5 step; here the mirror just returns `[]`). Replace the body of `mirrorPlanningToStore` with:
```ts
/** Mirror step 8b (Phase-2 / 09-impl): self-correcting hash-compare mirror.
 *  For each planning source: deserialize → compute incoming content-hash
 *  (planningContentHash, reusing merge-plan.hashEntry) → read the stored hash →
 *  branch:
 *    - no existing card (getCard null) → upsertCard (INSERT; dedup keep) + write hash;
 *    - stored hash ≠ incoming → updateCard (UPDATE content/frontmatter) + refresh hash;
 *    - hash match → skip (no write; cheap).
 *  Dedup is consulted ONLY for the new-card identity check (INSERT branch); the
 *  UPDATE branch bypasses dedup (pure identity cannot express update — the
 *  DedupDecision union is keep/merge/skip, by design). Returns the # of cards
 *  mirrored (INSERT+UPDATE; skips not counted) + conflict-marker efforts (T5).
 *  Independent of the zk seam (planning is hermes-internal). The store reuses the
 *  SAME SQLite DB the memory/knowledge cards use; memoryDir defaults to the
 *  existing hermes memory DB dir. No-op when planningFiles is empty. */
async function mirrorPlanningToStore(
  planningFiles: string[],
  memoryDir?: string,
): Promise<{ planningMirrored: number; conflictMarkerEfforts: string[] }> {
  const conflictMarkerEfforts: string[] = []; // populated in T5
  if (planningFiles.length === 0) return { planningMirrored: 0, conflictMarkerEfforts };
  const dir = memoryDir ?? join(AGENT_ROOT, "pi-hermes-memory");
  const store = await createCardStore({ memoryDir: dir });
  let planningMirrored = 0;
  try {
    for (const abs of planningFiles) {
      const kind = planningCardKindFromPath(abs);
      if (!kind) continue;
      let bytes = "";
      try {
        bytes = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const serializer = store.serializerFor(kind);
      const cards = serializer ? serializer.deserialize(bytes, { filePath: abs }) : [];
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
    }
  } finally {
    await store.close();
  }
  return { planningMirrored, conflictMarkerEfforts };
}
```
Update the call site in `walkAndIngest` (step 8b) to destructure the new return:
```ts
  // 8b. Planning DB-mirror (Phase-2 / 09-impl) — hash-compare INSERT/UPDATE/skip.
  const planMirror = await mirrorPlanningToStore(walk.files.planning, opts.memoryDir);
  const planningMirrored = planMirror.planningMirrored;
  const conflictMarkerEfforts = planMirror.conflictMarkerEfforts; // surfaced in T5's receipt
```
(Leave `conflictMarkerEfforts` a local for now; T5 adds it to the receipt. If the linter complains about an unused local in this task, reference it in a temporary `void conflictMarkerEfforts;` OR — preferred — add the receipt field already in this step's `WalkAndIngestReceipt` edit so it is consumed. Add `conflictMarkerEfforts: string[];` to the interface and `conflictMarkerEfforts,` to BOTH receipt returns now to avoid a dangling local.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/walk-and-ingest.test.ts )`
Expected: PASS (new drift tests + existing 08 planning walk test still green — INSERT path is unchanged behavior for a fresh card).

- [ ] **Step 6: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
Expected: all green.
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts
git -C <WT> commit -m "feat(knowledge-pipeline): planning mirror UPDATE path (hash-compare INSERT/UPDATE/skip) (09-impl T3)"
```

**DoD:** edited ticket → row UPDATED (not skipped); unchanged ticket → skip (`planningMirrored` 0 on re-mirror); new ticket → INSERT; 08's planning walk test still green; full suite green.

---

### Task 4: delete reconciliation (hard-delete on md absence) + `store.deleteCard`

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts` (add `deleteCard` to the `CardStore` interface + impl)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts` (add `reconcilePlanningDeletions`; call it from `walkAndIngest` after the mirror)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts` (delete-sweep test)

**Interfaces:**
- Produces:
  - `CardStore.deleteCard(id): Promise<void>` — `DELETE FROM memories WHERE md_id = ?`.
  - `reconcilePlanningDeletions(presentPlanningFiles, memoryDir?)` — given the set of planning md files PRESENT on disk, find DB planning-cards (kind `planning-effort` + `planning-ticket`) whose source md is absent → hard-delete the `memories` row + its `card_md_hash` row. Returns the # deleted (for the receipt / notify).

- [ ] **Step 1: Write the failing test (append to `__tests__/walk-and-ingest.test.ts`)**

```ts
describe("walkAndIngest — planning delete reconciliation (09-impl T4)", () => {
  it("hard-deletes planning rows whose source md vanished (md-wins)", async () => {
    const root = mkdtempSync(join(tmpdir(), "precon-"));
    const mem = mkdtempSync(join(tmpdir(), "precon-mem-"));
    try {
      const effort = "recon-del";
      const t01 = join(root, ".planning", effort, "tickets", "01-keep.md");
      const t02 = join(root, ".planning", effort, "tickets", "02-gone.md");
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      writeFileSync(t01, "---\ntype: task\nstatus: closed\n---\n# 01 — keep\n\n## Resolution\nKeep.\n");
      writeFileSync(t02, "---\ntype: task\nstatus: closed\n---\n# 02 — gone\n\n## Resolution\nGone.\n");
      await walkAndIngest(root, { memoryDir: mem });             // mirror both tickets
      // Source md for ticket 02 is removed (git rm / file deleted).
      require("node:fs").unlinkSync(t02);
      await walkAndIngest(root, { memoryDir: mem });             // re-walk → sweep deletes 02
      const store = await createCardStore({ memoryDir: mem });
      const tickets = await store.getCardsByKind("planning-ticket");
      await store.close();
      const ids = tickets.map((c) => c.id).sort();
      assert.deepEqual(ids, [`planning-ticket:${effort}:01`]);
      assert.ok(!ids.includes(`planning-ticket:${effort}:02`), "vanished ticket row must be hard-deleted");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});
```
> NOTE: replace the inline `require("node:fs")` with the file's existing `unlinkSync` import if present; otherwise add `unlinkSync` to the existing `node:fs` import.

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/walk-and-ingest.test.ts )`
Expected: FAIL — ticket 02's row persists (08's mirror never deletes; no sweep exists).

- [ ] **Step 3: Add `store.deleteCard`**

In `src/store/card-store.ts`, extend the `CardStore` interface (after `updateCard`):
```ts
  /** 09-impl: hard-delete a card row by Card.id (md-wins reconciliation — the
   *  source md vanished). Also paired with deleteCardMdHash by the sweep. */
  deleteCard(id: string): Promise<void>;
```
Implement on `store`:
```ts
    async deleteCard(id: string): Promise<void> {
      await runWithTransientRetry(() =>
        backend.withCorruptionRecovery(() => {
          getDb().prepare("DELETE FROM memories WHERE md_id = ?").run(id);
        }),
      );
    },
```

- [ ] **Step 4: Add `reconcilePlanningDeletions` + call it from `walkAndIngest`**

In `src/walk-and-ingest.ts`, add imports (alongside the T3 sync-state import):
```ts
import { deleteHash } from "./store/planning-sync-state.js";
import { parsePlanningPath, planningEffortId, planningTicketId } from "./store/planning-id.js";
```
Add the helper (next to `mirrorPlanningToStore`):
```ts
/** Mirror step 8c (Phase-2 / 09-impl): md-wins delete reconciliation. Given the
 *  set of planning md files PRESENT on disk, find DB planning-cards whose source
 *  md is absent → hard-delete the memories row + its card_md_hash row (Tier-1 md
 *  wins; the DB mirror must not keep rows for deleted md). Tombstoning is
 *  out-of-scope (09 hard-deletes). Returns the # of rows deleted. No-op when no
 *  planning-cards are stored. */
async function reconcilePlanningDeletions(
  presentPlanningFiles: string[],
  memoryDir?: string,
): Promise<{ planningDeleted: number }> {
  const presentIds = new Set<string>();
  for (const abs of presentPlanningFiles) {
    const info = parsePlanningPath(abs);
    if (!info) continue;
    presentIds.add(info.kind === "planning-effort" ? planningEffortId(info.effort) : planningTicketId(info.effort, info.ticketNo!));
  }
  const dir = memoryDir ?? join(AGENT_ROOT, "pi-hermes-memory");
  const store = await createCardStore({ memoryDir: dir });
  let planningDeleted = 0;
  try {
    for (const kind of ["planning-effort", "planning-ticket"] as const) {
      const rows = await store.getCardsByKind(kind);
      for (const card of rows) {
        if (!presentIds.has(card.id)) {
          await store.deleteCard(card.id);
          await deleteHash(store, card.id);
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
Call it from `walkAndIngest` AFTER the planning mirror (step 8b):
```ts
  // 8c. Planning delete reconciliation (Phase-2 / 09-impl) — md-wins sweep.
  await reconcilePlanningDeletions(walk.files.planning, opts.memoryDir);
```
(The # deleted is available for a future receipt field; 09-impl keeps the receipt minimal — `planningMirrored` + `conflictMarkerEfforts` — and does NOT add a `planningDeleted` field unless a later task needs it. If desired for diagnostics, add `planningDeleted: number` to the receipt in the same shape as `planningMirrored`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test __tests__/walk-and-ingest.test.ts )`
Expected: PASS (new delete test + T3 drift tests + 08 walk test).

- [ ] **Step 6: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
Expected: all green.
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/card-store.ts bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts
git -C <WT> commit -m "feat(knowledge-pipeline): planning delete reconciliation — md-wins hard-delete sweep (09-impl T4)"
```

**DoD:** removing a ticket md → its planning-ticket row + its `card_md_hash` row gone on next walk; other planning rows intact; full suite green.

---

### Task 5: conflict-marker detection (effort flag, surfaced in the receipt)

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/git-ops.ts` (add `hasMergeConflictMarkers(content)` — the merge-marker home, beside `MID_MERGE_SENTINELS`)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts` (scan md bytes in `mirrorPlanningToStore`; populate `conflictMarkerEfforts`; add the field to `WalkAndIngestReceipt` + both returns)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-id.ts` (add a tiny `effortOfPlanningId(id)` helper — or reuse `parsePlanningPath`; see Step 4)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts` (conflict-marker test)

> **Design note (pinned):** `git-ops.isMidMerge(gitDir)` is **repo-state** (true when sentinel files exist in `.git/` — i.e. a merge/rebase is actively unresolved, repo-wide). The grill asks for a **per-effort** flag ("if the merge left conflict markers in the md"). The precise per-effort signal is conflict markers IN the md **file bytes** (`<<<<<<<`/`=======`/`>>>>>>>`), which is a DIFFERENT signal from `isMidMerge`. 09 therefore adds a pure `hasMergeConflictMarkers(content)` helper in `git-ops.ts` (the merge-marker idiom's home, next to `MID_MERGE_SENTINELS`) and scans each planning file's bytes. `isMidMerge` is left UNCHANGED and remains available as a complementary repo-level check for future surfacing — 09 does NOT alter the `GitOps` interface or `realGitOps`.

**Interfaces:**
- Produces:
  - `hasMergeConflictMarkers(content: string): boolean` (git-ops.ts) — true when the text contains git conflict-marker lines.
  - `WalkAndIngestReceipt.conflictMarkerEfforts: string[]` — effort slugs whose md contains unresolved conflict markers (for human review; NOT a query, NOT blocking).

- [ ] **Step 1: Write the failing tests**

Create a focused git-ops test for the helper (or append to an existing git-ops test file if one exists): `src/git-ops-conflict-markers.test.ts`:
```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { hasMergeConflictMarkers } from "./git-ops.js";

describe("hasMergeConflictMarkers", () => {
  it("flags a full conflict-marker block", () => {
    const md = "# 08 — x\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n";
    assert.equal(hasMergeConflictMarkers(md), true);
  });
  it("flags a lone opening marker (mid-resolution)", () => {
    assert.equal(hasMergeConflictMarkers("<<<<<<< HEAD\nbody"), true);
  });
  it("does NOT flag normal md that merely contains seven chars", () => {
    // '=======' on its own line is a conflict divider, but the word "conflict"
    // or a horizontal-rule in body text must NOT trip a false positive.
    assert.equal(hasMergeConflictMarkers("# title\n\nsome ======= text here\n"), false);
    assert.equal(hasMergeConflictMarkers("---\nstatus: active\n---\n# map\n"), false);
  });
  it("is false for clean planning md", () => {
    assert.equal(hasMergeConflictMarkers("# 08 — x\n\n## Resolution\nClean.\n"), false);
  });
});
```
Append the receipt test to `__tests__/walk-and-ingest.test.ts`:
```ts
describe("walkAndIngest — conflict-marker flag (09-impl T5)", () => {
  it("surfaces an effort with unresolved merge markers in its ticket md", async () => {
    const root = mkdtempSync(join(tmpdir(), "pconf-"));
    const mem = mkdtempSync(join(tmpdir(), "pconf-mem-"));
    try {
      const effort = "conflict-effort";
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      writeFileSync(join(root, ".planning", effort, "tickets", "01-x.md"),
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b\n");
      const r = await walkAndIngest(root, { memoryDir: mem });
      assert.ok(r.conflictMarkerEfforts.includes(effort), "effort must be flagged for human review");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/git-ops-conflict-markers.test.ts __tests__/walk-and-ingest.test.ts )`
Expected: FAIL — `hasMergeConflictMarkers` not exported; `conflictMarkerEfforts` not on the receipt (or always empty).

- [ ] **Step 3: Add `hasMergeConflictMarkers` to git-ops.ts**

In `src/git-ops.ts`, add (next to `MID_MERGE_SENTINELS`):
```ts
/** Git conflict-marker line patterns (the `<<<<<<<`, `=======`, `>>>>>>>`
 *  markers `git merge` writes when it cannot auto-resolve). This is a FILE-CONTENT
 *  signal (per-file), distinct from {@link GitOps.isMidMerge} which is REPO-STATE
 *  (sentinel files in `.git/`, repo-wide). Anchored to line starts to avoid false
 *  positives on normal prose (a bare `=======` inside a sentence is not a divider). */
const CONFLICT_MARKER_LINE_RE = /(^|\n)(<<<<<<< |>>>>>>> |^=======$)/;
// Split for clarity: opening/closing are space-suffixed (`<<<<<<< HEAD`); the
// divider is the whole-line `=======`.
const CONFLICT_MARKER_RE = /(^|\n)(<<<<<<<[^\n]*|>>>>>>>[^\n]*|\n=======(?=\n|$))/;

/** True when `content` contains unresolved git conflict markers. Pure; no IO. */
export function hasMergeConflictMarkers(content: string): boolean {
  return CONFLICT_MARKER_RE.test(content);
}
```
> Use the single `CONFLICT_MARKER_RE` (the `CONFLICT_MARKER_LINE_RE` line above is an explanatory sketch — delete it and keep only `CONFLICT_MARKER_RE`). The regex matches an opening (`<<<<<<<` …) or closing (`>>>>>>>` …) marker OR a whole-line divider (`\n=======\n`), so it catches a full block AND a lone opening marker, while NOT matching `=======` mid-sentence. Verify against the Step-1 false-positive cases during implementation; tune anchors as needed so "some ======= text here" stays false.

- [ ] **Step 4: Populate `conflictMarkerEfforts` in the mirror**

In `src/walk-and-ingest.ts`, add the import:
```ts
import { hasMergeConflictMarkers } from "./git-ops.js";
```
In `mirrorPlanningToStore`, for each planning file (after reading `bytes`, before/after deserialize), detect + collect the effort slug. Reuse `parsePlanningPath(abs)` (already imported in T4) to derive the effort:
```ts
      // 09-impl T5: flag efforts whose md has unresolved merge markers (human review).
      if (hasMergeConflictMarkers(bytes)) {
        const info = parsePlanningPath(abs);
        if (info && !conflictMarkerEfforts.includes(info.effort)) {
          conflictMarkerEfforts.push(info.effort);
        }
      }
```
(The mirror STILL mirrors the card — conflict markers do NOT block the mirror; the markers are just bytes the serializer parses around. The flag is advisory.) Add `conflictMarkerEfforts: string[]` to the `WalkAndIngestReceipt` interface (if not added in T3) and to BOTH return objects in `walkAndIngest` (the `ok:false` early return gets `conflictMarkerEfforts: []`; the `ok:true` return gets `conflictMarkerEfforts`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/git-ops-conflict-markers.test.ts __tests__/walk-and-ingest.test.ts )`
Expected: PASS.

- [ ] **Step 6: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
Expected: all green.
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/git-ops.ts bun-apps/pi-agent-ext-hermes-memory/src/git-ops-conflict-markers.test.ts bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts bun-apps/pi-agent-ext-hermes-memory/src/store/planning-id.ts
git -C <WT> commit -m "feat(knowledge-pipeline): conflict-marker detection — effort flag in ingest receipt (09-impl T5)"
```
> Only `git add` the `planning-id.ts` path if T5 actually modified it (Step 4's "or reuse parsePlanningPath" — prefer reusing `parsePlanningPath`, so `planning-id.ts` is likely UNCHANGED and should NOT be staged). Drop it from the `git add` list if unmodified.

**DoD:** a ticket md with conflict markers → its effort slug in `receipt.conflictMarkerEfforts`; clean md → not flagged; mirror still runs (non-blocking); `isMidMerge`/`GitOps` unchanged; full suite green.

---

### Task 6: background backfill (session-backfill house-style)

**Files:**
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/handlers/planning-backfill.ts`
- Create: `bun-apps/pi-agent-ext-hermes-memory/src/handlers/planning-backfill.test.ts`
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/index.ts` (wire `schedulePlanningBackfill` into `pi.on("session_start", …)` alongside `scheduleSessionBackfill`)

**Interfaces:**
- Produces: `schedulePlanningBackfill(repoRoot, memoryDir, options)`, `planningBackfillState`, `PLANNING_BACKFILL_MAX_FILES`, `waitForPlanningBackfill` — mirroring `session-backfill.ts` shape.

- [ ] **Step 1: Write the failing test**

Create `src/handlers/planning-backfill.test.ts`:
```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { schedulePlanningBackfill, planningBackfillState, PLANNING_BACKFILL_MAX_FILES } from "./planning-backfill.js";
import { createCardStore } from "../src/store/card-store.js";

function flushedState() {
  return { inProgress: false, promise: null as Promise<void> | null };
}

describe("schedulePlanningBackfill", () => {
  it("re-mirrors a changed planning md within bounds (fake timers via injected setTimeout)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pbf-"));
    const mem = mkdtempSync(join(tmpdir(), "pbf-mem-"));
    const state = flushedState();
    let fired = false;
    const flush = (cb: () => void) => { fired = true; cb(); }; // run inline
    try {
      const effort = "backfill-eff";
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      writeFileSync(join(root, ".planning", effort, "tickets", "01-x.md"),
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nBackfilled.\n");
      schedulePlanningBackfill(root, mem, { state, setTimeoutFn: flush as never });
      // The injected setTimeout ran inline; await the (already-resolved) promise.
      await state.promise;
      assert.ok(fired);
      const store = await createCardStore({ memoryDir: mem });
      const c = await store.getCard(`planning-ticket:${effort}:01`);
      await store.close();
      assert.match(c?.content ?? "", /Backfilled\./);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });

  it("skips when a backfill is already in progress (run-state guard)", () => {
    const state = { inProgress: true, promise: Promise.resolve() };
    let called = false;
    const scheduled = schedulePlanningBackfill("/nonexistent", "/nonexistent", {
      state,
      setTimeoutFn: () => { called = true; } as never,
    });
    assert.equal(scheduled, false);
    assert.equal(called, false);
  });

  it("exports a MAX_FILES bound (parity with session backfill)", () => {
    assert.ok(PLANNING_BACKFILL_MAX_FILES > 0);
    assert.ok(planningBackfillState !== undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/handlers/planning-backfill.test.ts )`
Expected: FAIL — `Cannot find module "./planning-backfill.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/handlers/planning-backfill.ts` (mirror `session-backfill.ts` structure: deferred `setTimeout(0)`, run-state guard, MAX_FILES bound, best-effort notify):
```ts
// src/handlers/planning-backfill.ts — background backfill of the .planning card
// mirror (Phase-2 / 09-impl). Mirrors session-backfill.ts house-style: deferred
// via setTimeout(0) so session_start resolves first; run-state guard so two
// backfills never overlap in-process; MAX_FILES bound so a huge corpus can't
// stall startup. Idempotency = the mirror's hash-skip (re-mirroring unchanged
// files is a cheap hash-compare no-op — there is NO separate run-state file; a
// re-run resumes because unchanged cards hash-match-skip).
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { walkAndIngest } from "../walk-and-ingest.js";

export const PLANNING_BACKFILL_MAX_FILES = 50;

type NotifyLevel = "info" | "warning" | "error";
type NotifyFn = (message: string, level: NotifyLevel) => void;
type SetTimeoutFn = (callback: () => void, ms: number) => unknown;

export interface PlanningBackfillState {
  inProgress: boolean;
  promise: Promise<void> | null;
}

export const planningBackfillState: PlanningBackfillState = {
  inProgress: false,
  promise: null,
};

export interface SchedulePlanningBackfillOptions {
  notify?: NotifyFn;
  state?: PlanningBackfillState;
  setTimeoutFn?: SetTimeoutFn;
  maxFiles?: number;
}

/** Collect up to `maxFiles` planning-card md files under <repoRoot>/.planning.
 *  A cheap .planning-scoped recursive scan (NOT the full-repo walk) so startup
 *  cost stays bounded. Reuses planningCardKindFromPath to classify — same
 *  contract as walkKnowledgeSources, scoped to .planning/. */
function collectPlanningMdFiles(repoRoot: string, maxFiles: number): string[] {
  const out: string[] = [];
  const planningDir = join(repoRoot, ".planning");
  const recurse = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= maxFiles) return;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) recurse(abs);
      else if (name.endsWith(".md")) out.push(abs);
    }
  };
  recurse(planningDir);
  return out;
}

function notifyBestEffort(notify: NotifyFn | undefined, message: string, level: NotifyLevel): void {
  try {
    notify?.(message, level);
  } catch {
    /* Notification failures must never affect backfill. */
  }
}

/** Schedule a best-effort, bounded background re-mirror of .planning/. Mirrors
 *  scheduleSessionBackfill: deferred setTimeout(0); run-state guard; MAX_FILES
 *  bound; best-effort notify. The actual mirror reuses walkAndIngest's planning
 *  path (hash-compare INSERT/UPDATE/skip + delete reconciliation). Returns true
 *  when a backfill was scheduled; false when skipped (already in progress). */
export function schedulePlanningBackfill(
  repoRoot: string,
  memoryDir: string,
  options: SchedulePlanningBackfillOptions = {},
): boolean {
  const state = options.state ?? planningBackfillState;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const maxFiles = options.maxFiles ?? PLANNING_BACKFILL_MAX_FILES;

  if (state.inProgress) return false;

  state.inProgress = true;
  state.promise = new Promise<void>((resolve) => {
    setTimeoutFn(async () => {
      try {
        const files = collectPlanningMdFiles(repoRoot, maxFiles);
        if (files.length === 0) return;
        // walkAndIngest runs the hash-compare mirror + delete reconciliation
        // against these files (the hash-skip makes unchanged files cheap).
        await walkAndIngest(files, { memoryDir });
        notifyBestEffort(options.notify, `🧠 Planning backfill complete: scanned ${files.length} .planning file(s).`, "info");
      } catch (err) {
        notifyBestEffort(
          options.notify,
          `⚠️ Planning backfill failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      } finally {
        state.inProgress = false;
        state.promise = null;
        resolve();
      }
    }, 0);
  });
  return true;
}

/** Wait briefly for an in-progress planning backfill before shutdown (mirrors
 *  waitForSessionBackfill). */
export async function waitForPlanningBackfill(
  timeoutMs = 5000,
  state: PlanningBackfillState = planningBackfillState,
): Promise<boolean> {
  const promise = state.promise;
  if (!state.inProgress || !promise) return true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
```
> NOTE: `walkAndIngest` accepts `input: string | string[]` — passing the collected `files[]` scopes the mirror to exactly those files (the planning classifier keys off the `.planning` segment in each abs path, which the collected paths retain). This avoids re-walking the whole repo on every startup.

- [ ] **Step 4: Wire into index.ts**

In `src/index.ts`, add the import (next to the `session-backfill` import at the top):
```ts
import { schedulePlanningBackfill } from "./handlers/planning-backfill.js";
```
In the `pi.on("session_start", …)` handler, immediately AFTER the existing `scheduleSessionBackfill(…)` block (best-effort — wrap in try/catch like the stable-id backfill guard so a failure NEVER aborts startup):
```ts
    // Phase-2 (knowledge-pipeline / ticket 09): background re-mirror of .planning/.
    // Best-effort, bounded, run-state-guarded — mirrors scheduleSessionBackfill.
    // A failure must NEVER abort agent startup.
    try {
      schedulePlanningBackfill(ctx.cwd, memoryDir, {
        notify: (message, level) => {
          const ui = (ctx as { ui?: { notify?: (message: string, level?: string) => void } }).ui;
          if (ui?.notify) ui.notify(message, level);
          else if (level === "error" || level === "warning") console.warn(message);
          else console.info(message);
        },
      });
    } catch {
      /* never block startup */
    }
```
> `memoryDir` is the hermes memory DB dir already resolved in `index.ts` (the same dir `createCardStore` / `scheduleSessionBackfill` use — confirm the exact local var name in `index.ts` at implementation time and use it). `ctx.cwd` is the repo root (the dir containing `.planning/`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/handlers/planning-backfill.test.ts )`
Expected: PASS.

- [ ] **Step 6: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
Expected: all green (the index.ts wiring is additive; no existing handler test regresses).
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/handlers/planning-backfill.ts bun-apps/pi-agent-ext-hermes-memory/src/handlers/planning-backfill.test.ts bun-apps/pi-agent-ext-hermes-memory/src/index.ts
git -C <WT> commit -m "feat(knowledge-pipeline): planning background backfill — session_start sweep (09-impl T6)"
```

**DoD:** a changed planning md is re-mirrored on `session_start` within `MAX_FILES`; run-state prevents an overlapping backfill; index.ts startup is non-blocking; full suite green.

---

### Task 7: on-demand refresh (explicit — NOT every-read-rehash)

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.ts` (add `refreshPlanningCard(store, cardId, fsRoot)` + `refreshIfStale`)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.test.ts` (refresh tests)

**Interfaces:**
- Produces:
  - `refreshPlanningCard(store, cardId, fsRoot): Promise<{ action: "inserted" | "updated" | "unchanged" }>` — re-reads the source md for `cardId`, re-deserializes, re-hashes, re-mirrors via the SAME hash-compare branch as the mirror.
  - `refreshIfStale(store, cardId, fsRoot): Promise<boolean>` — true iff a refresh actually re-mirrored (drift detected).
- Documents (in the module doc): regular `getCard`/`getCardsByKind` return the DB row AS-IS (fast; no re-hash). Freshness is the backfill's job (T6) + explicit refresh (this task) — NEVER every-read-rehash.

> **Source-path derivation (pinned design choice — flag for the execution session):** `card_md_hash` keys by `card_id` only (no `source_path` column — the DDL is pinned in T1). `refreshPlanningCard` therefore re-derives the source md path from the id:
>   - `planning-effort:<effort>` → `<fsRoot>/.planning/<effort>/map.md`;
>   - `planning-ticket:<effort>:<no>` → glob `<fsRoot>/.planning/<effort>/tickets/<no>-*.md` (the id carries effort+no, NOT the slug — the slug is recovered by glob).
> If this proves awkward, a later task MAY add a `source_path` column to `card_md_hash` (additive); 09-impl keeps the pinned DDL and derives the path.

- [ ] **Step 1: Write the failing tests (append to `planning-sync-state.test.ts`)**

```ts
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
// (refreshPlanningCard + refreshIfStale already imported alongside the others)

describe("refreshPlanningCard (09-impl T7)", () => {
  const root = mkdtempSync(join(tmpdir(), "prefresh-"));
  const mem = mkdtempSync(join(tmpdir(), "prefresh-mem-"));
  const effort = "refresh-eff";
  const ticketPath = join(root, ".planning", effort, "tickets", "01-x.md");
  const id = `planning-ticket:${effort}:01`;

  it("inserts when no stored card exists", async () => {
    mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
    writeFileSync(ticketPath, "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nFirst.\n");
    const store = await createCardStore({ memoryDir: mem });
    try {
      const r = await refreshPlanningCard(store, id, root);
      assert.equal(r.action, "inserted");
    } finally {
      await store.close();
    }
  });

  it("updates when the source md changed (drift)", async () => {
    writeFileSync(ticketPath, "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n## Resolution\nEDITED.\n");
    const store = await createCardStore({ memoryDir: mem });
    try {
      const r = await refreshPlanningCard(store, id, root);
      assert.equal(r.action, "updated");
      const c = await store.getCard(id);
      assert.match(c?.content ?? "", /EDITED\./);
    } finally {
      await store.close();
    }
  });

  it("is unchanged (no write) when the source md is the same", async () => {
    const store = await createCardStore({ memoryDir: mem });
    try {
      const r = await refreshPlanningCard(store, id, root);
      assert.equal(r.action, "unchanged");
      assert.equal(await refreshIfStale(store, id, root), false);
    } finally {
      await store.close();
    }
  });

  it("returns {action:'absent'} when the source md vanished (caller may delete)", async () => {
    rmSync(ticketPath);
    const store = await createCardStore({ memoryDir: mem });
    try {
      const r = await refreshPlanningCard(store, id, root);
      assert.equal((r as { action: string }).action, "absent");
    } finally {
      await store.close();
    }
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(mem, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-sync-state.test.ts )`
Expected: FAIL — `refreshPlanningCard` / `refreshIfStale` not exported.

- [ ] **Step 3: Implement refresh**

Append to `src/store/planning-sync-state.ts` (imports: `readFileSync`, `readdirSync` from `node:fs`; `join` from `node:path`; `parsePlanningPath`/`planningEffortId`/`planningTicketId` from `./planning-id.js`; `getStoredHash`/`upsertHash` already local):
```ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parsePlanningPath } from "./planning-id.js";

export type RefreshAction = "inserted" | "updated" | "unchanged" | "absent";

/** Resolve the source md path for a planning Card.id under fsRoot.
 *  effort → <fsRoot>/.planning/<effort>/map.md;
 *  ticket → glob <fsRoot>/.planning/<effort>/tickets/<no>-*.md (slug recovered). */
function sourcePathForId(cardId: string, fsRoot: string): string | null {
  // effort
  if (cardId.startsWith("planning-effort:")) {
    const effort = cardId.slice("planning-effort:".length);
    return join(fsRoot, ".planning", effort, "map.md");
  }
  // ticket
  if (cardId.startsWith("planning-ticket:")) {
    const rest = cardId.slice("planning-ticket:".length); // <effort>:<no>
    const sep = rest.lastIndexOf(":");
    if (sep < 0) return null;
    const effort = rest.slice(0, sep);
    const no = rest.slice(sep + 1);
    const dir = join(fsRoot, ".planning", effort, "tickets");
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }
    const match = names.find((n) => n.startsWith(`${no}-`) && n.endsWith(".md"));
    return match ? join(dir, match) : null;
  }
  return null;
}

/** On-demand refresh of ONE planning card: re-read its source md, re-deserialize,
 *  re-hash, and re-mirror via the SAME hash-compare branch as the mirror (T3):
 *  no stored card → INSERT+hash; mismatch → UPDATE+hash; match → unchanged. If
 *  the source md is absent, returns {action:'absent'} so the caller can decide
 *  to delete (the T4 sweep hard-deletes). Explicit — call this when freshness
 *  is needed; regular getCard/getCardsByKind do NOT re-hash (they return the DB
 *  row as-is; freshness is the T6 backfill's job + this). */
export async function refreshPlanningCard(
  store: CardStore,
  cardId: string,
  fsRoot: string,
): Promise<{ action: RefreshAction }> {
  const src = sourcePathForId(cardId, fsRoot);
  if (!src) return { action: "absent" };
  let bytes: string;
  try {
    bytes = readFileSync(src, "utf8");
  } catch {
    return { action: "absent" };
  }
  // Derive the kind from the id prefix (the serializer registry is keyed by kind).
  const kind = cardId.startsWith("planning-effort:")
    ? "planning-effort"
    : cardId.startsWith("planning-ticket:")
      ? "planning-ticket"
      : null;
  if (!kind) return { action: "absent" };
  const serializer = store.serializerFor(kind);
  if (!serializer) return { action: "absent" };
  const cards = serializer.deserialize(bytes, { filePath: src });
  const card = cards.find((c) => c.id === cardId);
  if (!card) return { action: "absent" };

  const incomingHash = planningContentHash(card);
  const existing = await store.getCard(cardId);
  const stored = await getStoredHash(store, cardId);
  if (existing === null || stored === null) {
    await store.upsertCard(card);
    await upsertHash(store, cardId, incomingHash);
    return { action: "inserted" };
  }
  if (stored.hash !== incomingHash) {
    await store.updateCard(card);
    await upsertHash(store, cardId, incomingHash);
    return { action: "updated" };
  }
  return { action: "unchanged" };
}

/** True iff a refresh actually re-mirrored (drift detected). Thin wrapper. */
export async function refreshIfStale(store: CardStore, cardId: string, fsRoot: string): Promise<boolean> {
  const r = await refreshPlanningCard(store, cardId, fsRoot);
  return r.action === "inserted" || r.action === "updated";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-sync-state.test.ts )`
Expected: PASS.

- [ ] **Step 5: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
Expected: all green.
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.ts bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.test.ts
git -C <WT> commit -m "feat(knowledge-pipeline): on-demand planning refresh (explicit, not every-read-rehash) (09-impl T7)"
```

**DoD:** `refreshPlanningCard` re-hashes + re-mirrors a stale card (inserted/updated/unchanged/absent); `refreshIfStale` returns the drift boolean; regular reads are documented as non-rehashing; full suite green.

---

## Notes for the implementer

- `<WT>` = the repo worktree root. All `git -C <WT>` and `( cd ... )` calls use it.
- **Master invariant (memory/user/failure/knowledge must not regress):** T1 is an ADDITIVE new table (`card_md_hash`) + an idempotent `ensureCardMdHashTable` (CREATE TABLE IF NOT EXISTS — NOT a `memories` rebuild, so the C3 column-drift trap cannot fire; the `memories` schema is byte-identical after 09). T2/T3/T4 ADD methods to the `CardStore` façade (a separate object from `MemoryStore` — memory cards keep their section-md path unchanged). T3 REWRITES `mirrorPlanningToStore` (08-impl's append-once mirror) to hash-compare UPDATE/skip — the behavior change is intentional and localized to the planning mirror; 08's FILES (`planning-id`/`planning-parse`/`planning-serializer`/`planning-dedup`) are NOT semantically regressed (dedup stays pure identity — the `DedupDecision.action` union has no `"update"` by design). T5 is an ADDITIVE pure helper in git-ops.ts (the `GitOps` interface + `realGitOps` are UNCHANGED). T6 is an ADDITIVE handler + a non-blocking `session_start` wiring. T7 is ADDITIVE to `planning-sync-state.ts`. If any non-planning test breaks at a task boundary, **STOP and fix**.
- **09↔10 boundary:** 09 owns mirror drift (hash-compare INSERT/UPDATE/skip) + delete reconciliation + conflict-marker flag (effort-level, human review, in the receipt) + on-demand refresh + background backfill. 10 owns `stale:`/`conflict:` queries + graduation gate + dep-validation. **09 MUST NOT build a `stale:`/`conflict:` query or a graduation gate.** The `card_md_hash` table's `kind` discriminator (default `'mirror'`) is 10's foundation: design so 10 adds `kind='validated'` rows WITHOUT a migration (the column + index already exist from T1).
- **`card_md_hash` is ADDITIVE (no `memories` rebuild) — the C3 reassurance.** Unlike the T5 target-CHECK migrations (which rebuild `memories` and carry a 21-column list), T1's `ensureCardMdHashTable` is a plain `CREATE TABLE IF NOT EXISTS` on a NEW table — there is no data to carry, no column list to drift, no transaction. This is why hash state lives in its own table (NOT a `memories` column).
- **Hash width + key (pinned):** `planningContentHash(card) = hashEntry(canonicalCardBytes(card))` where `hashEntry` (from `merge-plan.ts`) is sha256 → **16 hex chars**. Keyed by `card.id` (the `card_md_hash.card_id` PK = `Card.id` = `memories.md_id`). Canonical bytes = `JSON.stringify({ kind, content, frontmatter: sortKeysDeep(frontmatter) })` — stable JSON with recursively-sorted keys so frontmatter key ORDER can't cause a spurious drift, while any content/frontmatter-VALUE change does.
- **`isMidMerge` vs conflict-marker scan (T5 design choice — pinned):** `git-ops.isMidMerge(gitDir)` is REPO-STATE (sentinel files in `.git/`, repo-wide). The grill asks for a PER-EFFORT flag, so T5 adds `hasMergeConflictMarkers(content)` — a pure FILE-CONTENT scan for `<<<<<<<`/`=======`/`>>>>>>>` — in git-ops.ts (the merge-marker home, beside `MID_MERGE_SENTINELS`). `isMidMerge`/`GitOps`/`realGitOps` are UNCHANGED; `hasMergeConflictMarkers` is an additive pure export.
- **Refresh source-path derivation (T7 design choice — flagged for the execution session):** `card_md_hash` has no `source_path` column (DDL pinned in T1), so `refreshPlanningCard` re-derives the source md path from the id (effort → `map.md`; ticket → glob `tickets/<no>-*.md` since the id carries no slug). If this proves awkward, a LATER task MAY add an additive `source_path` column; 09 keeps the pinned DDL.
- **Typecheck command:** this package's typecheck script is `check` (`tsc --noEmit`) — use `bun run check` (NOT `bun run typecheck`, which does not exist in this package). The `bun test` command runs the full `node:test` suite.
- **No wayfind import.** 09 reuses only hermes-internal primitives (`merge-plan.hashEntry`, `session-backfill` shape, `git-ops` markers, 08's planning-id/serializer/dedup). The `.planning` md format remains the contract.
