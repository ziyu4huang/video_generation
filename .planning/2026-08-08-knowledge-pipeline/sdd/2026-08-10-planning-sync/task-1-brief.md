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

