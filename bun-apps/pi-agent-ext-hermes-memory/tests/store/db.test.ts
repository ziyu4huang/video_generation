import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SqliteBackend, SQLITE_WAL_AUTOCHECKPOINT_PAGES, RawDatabase as Database } from '../../src/store/sqlite/sqlite-backend.js';
import type { DatabaseLike } from '../../src/store/sqlite/sqlite-backend.js';

/**
 * Read a PRAGMA scalar the runtime-agnostic way (prepare + first cell). Mirrors
 * better-sqlite3's `pragma(q, { simple: true })` WITHOUT depending on the
 * better-sqlite3-specific `.pragma()` method — which is intentionally absent
 * from the BunCompatDatabase shim — so the same assertion holds under both the
 * Node (better-sqlite3) and Bun (bun:sqlite) test paths.
 */
function pragmaSimple(db: DatabaseLike, query: string): unknown {
  const row = db.prepare(`PRAGMA ${query}`).get() as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
}

describe('SqliteBackend', () => {
  let tmpDir: string;
  let dbManager: SqliteBackend;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-'));
    dbManager = new SqliteBackend(tmpDir);
  });

  afterEach(() => {
    dbManager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function assertQuickCheckOk(db: InstanceType<typeof Database>): void {
    const rows = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    assert.deepStrictEqual(rows.map((row) => Object.values(row)[0]), ['ok']);
  }

  function corruptSqliteError(): Error & { code: string } {
    const err = new Error('SQLITE_CORRUPT: database disk image is malformed') as Error & { code: string };
    err.code = 'SQLITE_CORRUPT';
    return err;
  }

  function corruptRecoverableIndexPage(dbPath: string, indexName: string): void {
    const db = new Database(dbPath);
    const pageSize = pragmaSimple(db, 'page_size') as number;
    // Use sqlite_schema.rootpage (always available) instead of dbstat — dbstat
    // is a compile-time option (SQLITE_ENABLE_DBSTAT_VTAB) that bun:sqlite does
    // NOT enable on Linux, so `SELECT ... FROM dbstat` fails to PREPARE there
    // (the original root cause of the D3 Linux divergence). The index's
    // rootpage is its b-tree ROOT; corrupting it fails quick_check while
    // leaving every table's DATA b-tree (a separate root) fully readable, so
    // recovery deterministically reads ALL rows on every SQLite build.
    const row = db.prepare(
      "SELECT rootpage FROM sqlite_schema WHERE type = 'index' AND name = ?"
    ).get(indexName) as { rootpage: number } | undefined;
    db.close();

    assert.ok(row, `sqlite_schema did not find index rootpage for ${indexName}`);
    assert.ok(row.rootpage > 1, 'will not corrupt sqlite database header page');

    const buffer = fs.readFileSync(dbPath);
    const offset = (row.rootpage - 1) * pageSize;
    for (let i = 0; i < 16 && offset + i < buffer.length; i++) {
      buffer[offset + i] ^= 0xff;
    }
    fs.writeFileSync(dbPath, buffer);

    const checkDb = new Database(dbPath);
    try {
      const rows = checkDb.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
      const ok = rows.length === 1 && Object.values(rows[0])[0] === 'ok';
      assert.equal(ok, false, 'test fixture must produce a quick_check failure');
      assert.doesNotThrow(() => {
        checkDb.prepare('SELECT COUNT(*) as count FROM sessions NOT INDEXED').get();
        checkDb.prepare('SELECT COUNT(*) as count FROM messages NOT INDEXED').get();
        checkDb.prepare('SELECT COUNT(*) as count FROM memories NOT INDEXED').get();
      }, 'test fixture must leave core table scans readable');
    } finally {
      checkDb.close();
    }
  }

  describe('initialization', () => {
    it('should create database file on first getDb() call', () => {
      assert.strictEqual(dbManager.exists(), false);
      const db = dbManager.getDb();
      assert.ok(db);
      assert.strictEqual(dbManager.exists(), true);
    });

    it('should create sessions.db in the specified directory', () => {
      dbManager.getDb();
      const expectedPath = path.join(tmpDir, 'sessions.db');
      assert.strictEqual(dbManager.getPath(), expectedPath);
      assert.ok(fs.existsSync(expectedPath));
    });

    it('should return same db instance on multiple getDb() calls', () => {
      const db1 = dbManager.getDb();
      const db2 = dbManager.getDb();
      assert.strictEqual(db1, db2);
    });

    it('should create parent directory if it does not exist', () => {
      const nestedDir = path.join(tmpDir, 'nested', 'dir');
      const manager = new SqliteBackend(nestedDir);
      manager.getDb();
      assert.ok(fs.existsSync(path.join(nestedDir, 'sessions.db')));
      manager.close();
    });
  });

  describe('schema', () => {
    it('should create all required tables', () => {
      const db = dbManager.getDb();
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
      `).all() as { name: string }[];

      const tableNames = tables.map(t => t.name);
      assert.ok(tableNames.includes('sessions'), 'sessions table missing');
      assert.ok(tableNames.includes('messages'), 'messages table missing');
      assert.ok(tableNames.includes('memories'), 'memories table missing');
    });

    it('should create FTS5 virtual tables', () => {
      const db = dbManager.getDb();
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%'
      `).all() as { name: string }[];

      const tableNames = tables.map(t => t.name);
      assert.ok(tableNames.includes('message_fts'), 'message_fts table missing');
      assert.ok(tableNames.includes('memory_fts'), 'memory_fts table missing');
    });

    it('should create triggers for FTS sync', () => {
      const db = dbManager.getDb();
      const triggers = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='trigger'
      `).all() as { name: string }[];

      const triggerNames = triggers.map(t => t.name);
      assert.ok(triggerNames.includes('messages_ai'), 'messages_ai trigger missing');
      assert.ok(triggerNames.includes('messages_ad'), 'messages_ad trigger missing');
      assert.ok(triggerNames.includes('messages_au'), 'messages_au trigger missing');
      assert.ok(triggerNames.includes('memories_ai'), 'memories_ai trigger missing');
      assert.ok(triggerNames.includes('memories_ad'), 'memories_ad trigger missing');
      assert.ok(triggerNames.includes('memories_au'), 'memories_au trigger missing');
    });

    it('should be idempotent — running schema twice does not error', () => {
      const db = dbManager.getDb();
      // The schema uses IF NOT EXISTS, so running it again should be safe
      assert.doesNotThrow(() => {
        dbManager.close();
        dbManager = new SqliteBackend(tmpDir);
        dbManager.getDb();
      });
    });

    it('should migrate legacy memories table without category column', () => {
      const dbPath = path.join(tmpDir, 'sessions.db');
      const legacyDb = new Database(dbPath);

      legacyDb.exec(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT,
          target TEXT NOT NULL CHECK (target IN ('memory', 'user')),
          content TEXT NOT NULL,
          created DATE NOT NULL,
          last_referenced DATE NOT NULL
        );
      `);
      legacyDb.close();

      const migratedManager = new SqliteBackend(tmpDir);
      const migratedDb = migratedManager.getDb();
      const columns = migratedDb.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
      const names = columns.map((c) => c.name);

      assert.ok(names.includes('category'));
      assert.ok(names.includes('failure_reason'));
      assert.ok(names.includes('tool_state'));
      assert.ok(names.includes('corrected_to'));

      migratedManager.close();
    });

    it('should add mw_success/mw_fail columns to a legacy memories table lacking them', () => {
      // Forge a legacy memories table that is the current canonical shape EXCEPT
      // it lacks mw_success/mw_fail AND still carries the legacy target CHECK
      // (memory/user only). Reopening via SqliteBackend must therefore exercise
      // BOTH migration paths: ensureMemoriesColumns (ADD COLUMN with DEFAULT 0)
      // AND migrateLegacyMemoriesTargetConstraint (rebuild via memories_new —
      // both the DDL and the INSERT...SELECT must carry the new columns, or the
      // rebuild silently drops them).
      const dbPath = path.join(tmpDir, 'sessions.db');
      const legacyDb = new Database(dbPath);

      legacyDb.exec(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT,
          target TEXT NOT NULL CHECK (target IN ('memory', 'user')),
          category TEXT,
          content TEXT NOT NULL,
          failure_reason TEXT,
          tool_state TEXT,
          corrected_to TEXT,
          created DATE NOT NULL,
          last_referenced DATE NOT NULL
        );
      `);
      legacyDb.prepare(`
        INSERT INTO memories (project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(null, 'memory', null, 'legacy memory entry', null, null, null, '2026-05-09', '2026-05-09');
      legacyDb.close();

      const migratedManager = new SqliteBackend(tmpDir);
      const migratedDb = migratedManager.getDb();
      const columns = migratedDb.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
      const names = columns.map((c) => c.name);

      assert.ok(names.includes('mw_success'), 'mw_success column should be migrated onto legacy memories table');
      assert.ok(names.includes('mw_fail'), 'mw_fail column should be migrated onto legacy memories table');

      // ADD COLUMN ... DEFAULT 0 (and the rebuild INSERT...SELECT) must backfill
      // the pre-existing row with 0, not NULL.
      const row = migratedDb.prepare('SELECT mw_success, mw_fail FROM memories').get() as { mw_success: number; mw_fail: number };
      assert.strictEqual(row.mw_success, 0);
      assert.strictEqual(row.mw_fail, 0);

      migratedManager.close();
    });

    it('should add status/supersedes/superseded_by/parent_ids columns to a legacy memories table lacking them', () => {
      // Forge a legacy memories table that is the current canonical shape EXCEPT
      // it lacks the supersession columns (status/supersedes/superseded_by/
      // parent_ids) AND still carries the legacy target CHECK (memory/user only).
      // Reopening via SqliteBackend must therefore exercise BOTH migration paths:
      // ensureMemoriesColumns (4 ADD COLUMNs) AND migrateLegacyMemoriesTargetConstraint
      // (rebuild via memories_new — BOTH copies of the DDL and the INSERT...SELECT
      // must carry the new columns, or the rebuild silently drops them).
      const dbPath = path.join(tmpDir, 'sessions.db');
      const legacyDb = new Database(dbPath);

      legacyDb.exec(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT,
          target TEXT NOT NULL CHECK (target IN ('memory', 'user')),
          category TEXT,
          content TEXT NOT NULL,
          failure_reason TEXT,
          tool_state TEXT,
          corrected_to TEXT,
          created DATE NOT NULL,
          last_referenced DATE NOT NULL,
          mw_success INTEGER NOT NULL DEFAULT 0,
          mw_fail INTEGER NOT NULL DEFAULT 0
        );
      `);
      legacyDb.prepare(`
        INSERT INTO memories (project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced, mw_success, mw_fail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(null, 'memory', null, 'legacy memory entry', null, null, null, '2026-05-09', '2026-05-09', 0, 0);
      legacyDb.close();

      const migratedManager = new SqliteBackend(tmpDir);
      const migratedDb = migratedManager.getDb();
      const columns = migratedDb.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
      const names = columns.map((c) => c.name);

      assert.ok(names.includes('status'), 'status column should be migrated onto legacy memories table');
      assert.ok(names.includes('supersedes'), 'supersedes column should be migrated onto legacy memories table');
      assert.ok(names.includes('superseded_by'), 'superseded_by column should be migrated onto legacy memories table');
      assert.ok(names.includes('parent_ids'), 'parent_ids column should be migrated onto legacy memories table');

      // ADD COLUMN ... DEFAULT 'active' (status) / NULL (the rest) and the rebuild
      // INSERT...SELECT must backfill the pre-existing row with those defaults.
      const row = migratedDb.prepare('SELECT status, supersedes, superseded_by, parent_ids FROM memories').get() as {
        status: string;
        supersedes: number | null;
        superseded_by: number | null;
        parent_ids: string | null;
      };
      assert.strictEqual(row.status, 'active');
      assert.strictEqual(row.supersedes, null);
      assert.strictEqual(row.superseded_by, null);
      assert.strictEqual(row.parent_ids, null);

      migratedManager.close();
    });

    it('should migrate legacy sessions table without project column', () => {
      const dbPath = path.join(tmpDir, 'sessions.db');
      const legacyDb = new Database(dbPath);

      legacyDb.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          message_count INTEGER DEFAULT 0
        );
      `);
      legacyDb.prepare(`
        INSERT INTO sessions (id, cwd, started_at)
        VALUES (?, ?, ?)
      `).run('legacy-session', '/work/my-app', '2026-05-03T00:00:00Z');
      legacyDb.close();

      const migratedManager = new SqliteBackend(tmpDir);
      const migratedDb = migratedManager.getDb();
      const columns = migratedDb.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
      const names = columns.map((c) => c.name);

      assert.ok(names.includes('project'));

      const row = migratedDb.prepare('SELECT project FROM sessions WHERE id = ?').get('legacy-session') as { project: string };
      assert.strictEqual(row.project, 'my-app');

      assert.doesNotThrow(() => {
        migratedDb.prepare(`
          INSERT INTO sessions (id, project, cwd, started_at)
          VALUES (?, ?, ?, ?)
        `).run('new-session', 'new-project', '/work/new-project', '2026-05-04T00:00:00Z');
      });

      migratedManager.close();
    });

    it('should migrate legacy memories table without project column', () => {
      const dbPath = path.join(tmpDir, 'sessions.db');
      const legacyDb = new Database(dbPath);

      legacyDb.exec(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          target TEXT NOT NULL CHECK (target IN ('memory', 'user')),
          content TEXT NOT NULL,
          created DATE NOT NULL,
          last_referenced DATE NOT NULL
        );
      `);
      legacyDb.prepare(`
        INSERT INTO memories (target, content, created, last_referenced)
        VALUES (?, ?, ?, ?)
      `).run('memory', 'legacy memory entry', '2026-05-09', '2026-05-09');
      legacyDb.close();

      const migratedManager = new SqliteBackend(tmpDir);
      const migratedDb = migratedManager.getDb();
      const columns = migratedDb.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
      const names = columns.map((c) => c.name);

      assert.ok(names.includes('project'));

      const row = migratedDb.prepare('SELECT project, content FROM memories').get() as {
        project: string | null;
        content: string;
      };
      assert.strictEqual(row.project, null);
      assert.strictEqual(row.content, 'legacy memory entry');

      migratedManager.close();
    });

    it('widens the target CHECK to allow knowledge AND preserves md_id/state/severity/pin (06a task 5 — data-loss guard)', () => {
      // Forge a CURRENT-shape memories table: the 3-value target CHECK
      // (memory/user/failure) WITHOUT 'knowledge', and the full column set
      // EXCEPT the new `frontmatter` column (simulating a DB from before this
      // task). Seed a row with NON-default md_id/state/severity/pin, reopen via
      // SqliteBackend (which runs the 06a migration), and assert BOTH:
      //   (a) the row's md_id/state/severity/pin survive the table rewrite
      //       (the data-loss guard — a rewrite that dropped these columns would
      //       silently default them), AND
      //   (b) 'knowledge' is now insertable (the CHECK was widened).
      const dbPath = path.join(tmpDir, 'sessions.db');
      const legacyDb = new Database(dbPath);

      legacyDb.exec(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT,
          target TEXT NOT NULL CHECK (target IN ('memory', 'user', 'failure')),
          category TEXT CHECK (category IN ('failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk')),
          content TEXT NOT NULL,
          failure_reason TEXT,
          tool_state TEXT,
          corrected_to TEXT,
          created DATE NOT NULL,
          last_referenced DATE NOT NULL,
          mw_success INTEGER NOT NULL DEFAULT 0,
          mw_fail INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active',
          supersedes INTEGER,
          superseded_by INTEGER,
          parent_ids TEXT,
          md_id TEXT,
          state TEXT NOT NULL DEFAULT 'active',
          severity INTEGER,
          pin INTEGER NOT NULL DEFAULT 0
        );
      `);
      legacyDb.prepare(`
        INSERT INTO memories (project, target, category, content, created, last_referenced, mw_success, mw_fail, status, md_id, state, severity, pin)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('proj-1', 'failure', 'failure', 'non-default payload', '2026-05-09', '2026-05-09', 7, 3, 'active', 'md-abc-123', 'resolved', 2, 1);
      legacyDb.close();

      const migratedManager = new SqliteBackend(tmpDir);
      const migratedDb = migratedManager.getDb();

      // (a) data-loss guard: every column carried through the rewrite verbatim.
      const row = migratedDb.prepare(
        'SELECT md_id, state, severity, pin, mw_success, mw_fail, status, project, target, category, content FROM memories'
      ).get() as {
        md_id: string | null;
        state: string;
        severity: number | null;
        pin: number;
        mw_success: number;
        mw_fail: number;
        status: string;
        project: string | null;
        target: string;
        category: string | null;
        content: string;
      };
      assert.strictEqual(row.md_id, 'md-abc-123', 'md_id must survive the rewrite');
      assert.strictEqual(row.state, 'resolved', 'state must survive the rewrite');
      assert.strictEqual(row.severity, 2, 'severity must survive the rewrite');
      assert.strictEqual(row.pin, 1, 'pin must survive the rewrite');
      assert.strictEqual(row.mw_success, 7, 'mw_success must survive the rewrite');
      assert.strictEqual(row.mw_fail, 3, 'mw_fail must survive the rewrite');
      assert.strictEqual(row.content, 'non-default payload', 'content must survive the rewrite');
      assert.strictEqual(row.target, 'failure', 'target must survive the rewrite');

      // The new nullable frontmatter column is present (added by the cheap
      // ALTER step) and NULL for the memory row.
      const cols = (migratedDb.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).map((c) => c.name);
      assert.ok(cols.includes('frontmatter'), 'frontmatter column must exist after migration');
      const fmRow = migratedDb.prepare('SELECT frontmatter FROM memories').get() as { frontmatter: string | null };
      assert.strictEqual(fmRow.frontmatter, null, 'frontmatter is NULL for memory rows');

      // (b) the CHECK was widened: 'knowledge' is now accepted.
      assert.doesNotThrow(() => {
        migratedDb.prepare(`
          INSERT INTO memories (target, content, created, last_referenced, md_id, frontmatter)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run('knowledge', 'a knowledge card', '2026-05-09', '2026-05-09', 'k-1', '{"id":"k-1"}');
      }, 'knowledge target must be insertable after the CHECK widen');

      migratedManager.close();
    });

    it('should migrate legacy target CHECK constraint to allow failure entries', () => {
      const dbPath = path.join(tmpDir, 'sessions.db');
      const legacyDb = new Database(dbPath);

      legacyDb.exec(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT,
          target TEXT NOT NULL CHECK (target IN ('memory', 'user')),
          category TEXT,
          content TEXT NOT NULL,
          failure_reason TEXT,
          tool_state TEXT,
          corrected_to TEXT,
          created DATE NOT NULL,
          last_referenced DATE NOT NULL
        );
      `);
      legacyDb.prepare(`
        INSERT INTO memories (project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(null, 'memory', null, 'existing memory', null, null, null, '2026-05-09', '2026-05-09');
      legacyDb.close();

      const migratedManager = new SqliteBackend(tmpDir);
      const migratedDb = migratedManager.getDb();

      assert.doesNotThrow(() => {
        migratedDb.prepare(`
          INSERT INTO memories (project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(null, 'failure', 'failure', 'failed setup', 'legacy check fixed', null, null, '2026-05-09', '2026-05-09');
      });

      const rows = migratedDb.prepare(`SELECT target, content FROM memories ORDER BY id ASC`).all() as Array<{ target: string; content: string }>;
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].content, 'existing memory');
      assert.strictEqual(rows[1].target, 'failure');

      migratedManager.close();
    });
  });

  describe('corruption recovery', () => {
    it('repairs recoverable corruption on open and preserves readable rows', () => {
      const db = dbManager.getDb();
      db.prepare(`
        INSERT INTO sessions (id, project, cwd, started_at)
        VALUES (?, ?, ?, ?)
      `).run('recover-session', 'recover-project', '/work/recover', '2026-05-03T00:00:00Z');

      const insertMessage = db.prepare(`
        INSERT INTO messages (id, session_id, role, content, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < 50; i++) {
        insertMessage.run(`recover-msg-${i}`, 'recover-session', i % 2 === 0 ? 'user' : 'assistant', `message ${i}`, `2026-05-03T00:${String(i).padStart(2, '0')}:00Z`);
      }

      db.prepare(`
        INSERT INTO memories (project, target, content, created, last_referenced)
        VALUES (?, ?, ?, ?, ?)
      `).run(null, 'memory', 'recoverable memory', '2026-05-03', '2026-05-03');
      // FIX 2 (whole-branch review): a card-store row (06a/03 columns) must
      // survive the corruption rebuild with md_id/state/severity/pin/
      // frontmatter/graph intact — the recovery copy previously dropped all
      // six columns (md_id/state/severity/pin pre-existing since 06a-era
      // schema additions; frontmatter since 06a; graph since 03).
      db.prepare(`
        INSERT INTO memories (project, target, content, created, last_referenced, md_id, state, severity, pin, frontmatter, graph)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        null,
        'knowledge',
        'recoverable knowledge card',
        '2026-05-03',
        '2026-05-03',
        'knowledge:recoverable',
        'active',
        3,
        1,
        JSON.stringify({ id: 'knowledge:recoverable', record_type: 'lever' }),
        JSON.stringify({ links: ['other-card'], relations: [{ s: 'a', rel: 'references', o: 'b' }] }),
      );
      dbManager.close();

      corruptRecoverableIndexPage(path.join(tmpDir, 'sessions.db'), 'idx_messages_timestamp');

      dbManager = new SqliteBackend(tmpDir);
      const repairedDb = dbManager.getDb();

      assert.strictEqual(dbManager.getLastRecovery()?.strategy, 'rebuilt');
      // Corrupting the index ROOT (a separate b-tree from table data — see
      // corruptRecoverableIndexPage) deterministically preserves every table
      // row across SQLite builds, so the exact recovered count is assertable.
      assert.deepStrictEqual(dbManager.getLastRecovery()?.recoveredRows, {
        extension_metadata: 0,
        sessions: 1,
        messages: 50,
        session_files: 0,
        memories: 2,
      });
      assert.deepStrictEqual(dbManager.getStats(), { sessions: 1, messages: 50, memories: 2 });
      const memory = repairedDb.prepare('SELECT content FROM memories WHERE content = ?').get('recoverable memory') as { content: string } | undefined;
      assert.ok(memory);
      // FIX 2: the card-store row rebuilt with ALL 06a/03 columns intact —
      // md_id (card-store join key), state/severity/pin, frontmatter + graph
      // (JSON envelopes) all survive the rebuild byte-for-byte.
      const card = repairedDb
        .prepare(
          'SELECT md_id, state, severity, pin, frontmatter, graph FROM memories WHERE md_id = ?',
        )
        .get('knowledge:recoverable') as
        | { md_id: string; state: string; severity: number; pin: number; frontmatter: string; graph: string }
        | undefined;
      assert.ok(card, 'recovered card-store row kept its md_id');
      assert.strictEqual(card.state, 'active');
      assert.strictEqual(card.severity, 3);
      assert.strictEqual(card.pin, 1);
      assert.deepStrictEqual(JSON.parse(card.frontmatter), { id: 'knowledge:recoverable', record_type: 'lever' });
      assert.deepStrictEqual(JSON.parse(card.graph), {
        links: ['other-card'],
        relations: [{ s: 'a', rel: 'references', o: 'b' }],
      });
      assertQuickCheckOk(repairedDb as InstanceType<typeof Database>);
      assert.ok(fs.readdirSync(tmpDir).some((name) => name.startsWith('sessions.db.corrupt-')), 'corrupt DB should be quarantined');
    });

    it('quarantines unrecoverable files and recreates an empty database', () => {
      dbManager.close();
      const dbPath = path.join(tmpDir, 'sessions.db');
      fs.writeFileSync(dbPath, 'not a sqlite database');

      dbManager = new SqliteBackend(tmpDir);
      const db = dbManager.getDb();

      assert.strictEqual(dbManager.getLastRecovery()?.strategy, 'recreated-empty');
      assert.deepStrictEqual(dbManager.getStats(), { sessions: 0, messages: 0, memories: 0 });
      assertQuickCheckOk(db as InstanceType<typeof Database>);
      assert.ok(fs.readdirSync(tmpDir).some((name) => name.startsWith('sessions.db.corrupt-')), 'unrecoverable DB should be quarantined');
    });

    it('retries a corrupt operation once after self-healing', () => {
      dbManager.getDb();
      let attempts = 0;

      const result = dbManager.withCorruptionRecovery(() => {
        attempts++;
        if (attempts === 1) throw corruptSqliteError();
        return 'ok';
      });

      assert.strictEqual(result, 'ok');
      assert.strictEqual(attempts, 2);
      assert.strictEqual(dbManager.getLastRecovery()?.strategy, 'rebuilt');
    });
  });

  describe('close', () => {
    it('should close database connection', () => {
      const db = dbManager.getDb();
      assert.ok(db);
      dbManager.close();
      // After close, getDb should create a new connection
      const db2 = dbManager.getDb();
      assert.ok(db2);
      assert.notStrictEqual(db, db2);
    });

    it('should be safe to call close multiple times', () => {
      dbManager.getDb();
      assert.doesNotThrow(() => {
        dbManager.close();
        dbManager.close();
      });
    });

    it('should truncate the WAL file on close so it is not retained across sessions', () => {
      const db = dbManager.getDb();
      const walPath = `${dbManager.getPath()}-wal`;

      // Generate enough WAL traffic to materialize a non-trivial WAL file.
      const insert = db.prepare(`
        INSERT INTO memories (project, target, content, created, last_referenced)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < 500; i++) {
        insert.run(null, 'memory', `entry ${i} ${'x'.repeat(200)}`, '2026-05-03', '2026-05-03');
      }
      assert.ok(fs.existsSync(walPath), 'WAL file should exist after writes');
      assert.ok(fs.statSync(walPath).size > 0, 'WAL should be non-empty before close');

      // close() runs PRAGMA wal_checkpoint(TRUNCATE), which shrinks the WAL to 0.
      dbManager.close();

      const walSizeAfter = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
      assert.strictEqual(walSizeAfter, 0, 'WAL should be truncated to 0 bytes after close');
    });
  });

  describe('getStats', () => {
    it('should return zero counts for empty database', () => {
      dbManager.getDb();
      const stats = dbManager.getStats();
      assert.strictEqual(stats.sessions, 0);
      assert.strictEqual(stats.messages, 0);
      assert.strictEqual(stats.memories, 0);
    });

    it('should count inserted records', () => {
      const db = dbManager.getDb();

      // Insert a session
      db.prepare(`
        INSERT INTO sessions (id, project, cwd, started_at)
        VALUES (?, ?, ?, ?)
      `).run('test-session-1', 'test-project', '/test/cwd', '2026-05-03T00:00:00Z');

      // Insert a message
      db.prepare(`
        INSERT INTO messages (id, session_id, role, content, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).run('test-msg-1', 'test-session-1', 'user', 'Hello', '2026-05-03T00:01:00Z');

      // Insert a memory
      db.prepare(`
        INSERT INTO memories (project, target, content, created, last_referenced)
        VALUES (?, ?, ?, ?, ?)
      `).run(null, 'memory', 'prefers pnpm', '2026-05-03', '2026-05-03');

      const stats = dbManager.getStats();
      assert.strictEqual(stats.sessions, 1);
      assert.strictEqual(stats.messages, 1);
      assert.strictEqual(stats.memories, 1);
    });
  });

  describe('WAL mode', () => {
    it('should enable WAL mode for concurrent reads', () => {
      const db = dbManager.getDb();
      const result = pragmaSimple(db, 'journal_mode') as string;
      assert.strictEqual(result, 'wal');
    });

    it('should use SQLite default-size WAL autocheckpoints', () => {
      const db = dbManager.getDb();
      const result = pragmaSimple(db, 'wal_autocheckpoint') as number;
      assert.strictEqual(result, SQLITE_WAL_AUTOCHECKPOINT_PAGES);
    });
  });

  describe('foreign keys', () => {
    it('should enforce foreign key constraints', () => {
      const db = dbManager.getDb();
      const result = pragmaSimple(db, 'foreign_keys') as number;
      assert.strictEqual(result, 1);

      // Inserting a message with non-existent session_id should fail
      assert.throws(() => {
        db.prepare(`
          INSERT INTO messages (id, session_id, role, content, timestamp)
          VALUES (?, ?, ?, ?, ?)
        `).run('bad-msg', 'nonexistent-session', 'user', 'test', '2026-05-03T00:00:00Z');
      }, /FOREIGN KEY/);
    });
  });

  describe('stale backup pruning (fixes unbounded quarantine clutter)', () => {
    function seedClutter(dir: string, tags: string[]): void {
      const now = Math.floor(Date.now() / 1000);
      tags.forEach((tag, i) => {
        const f = path.join(dir, `sessions.db.${tag}`);
        fs.writeFileSync(f, 'x');
        // distinct mtimes, monotonically newer per index (index 0 = oldest)
        const t = now - (tags.length - i) * 1000;
        fs.utimesSync(f, t, t);
      });
    }

    it('pruneStaleBackups keeps the N newest clutter files, deletes the rest', () => {
      dbManager.getDb();
      seedClutter(tmpDir, ['corrupt-0', 'bak-0', 'corrupt-1', 'bak-1', 'corrupt-2']);
      const deleted = dbManager.pruneStaleBackups({ keepRecent: 2 });
      assert.equal(deleted.length, 3, 'deletes 3 of 5 (keeps 2 newest)');
      const remaining = fs.readdirSync(tmpDir).filter((n) => /^sessions\.db\.(corrupt|bak)-/.test(n)).sort();
      assert.deepEqual(remaining, ['sessions.db.bak-1', 'sessions.db.corrupt-2']);
    });

    it('never touches the live sessions.db / wal / shm', () => {
      dbManager.getDb();
      seedClutter(tmpDir, ['corrupt-x']);
      assert.ok(fs.existsSync(path.join(tmpDir, 'sessions.db')));
      const deleted = dbManager.pruneStaleBackups({ keepRecent: 0 });
      assert.ok(deleted.includes('sessions.db.corrupt-x'), 'clutter deleted');
      assert.ok(fs.existsSync(path.join(tmpDir, 'sessions.db')), 'live db survives');
    });

    it('ignores out-of-scope files (markdown backups live in the same dir)', () => {
      dbManager.getDb();
      const md = path.join(tmpDir, 'failures.md.bak-old');
      fs.writeFileSync(md, 'x');
      dbManager.pruneStaleBackups({ keepRecent: 0 });
      assert.ok(fs.existsSync(md), 'markdown backups are out of scope');
    });

    it('auto-prunes on first open (default keepRecent)', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-prune-on-open-'));
      try {
        seedClutter(dir, ['corrupt-0', 'bak-0', 'corrupt-1', 'bak-1', 'corrupt-2']);
        const mgr = new SqliteBackend(dir);
        mgr.getDb(); // first open auto-prunes
        const remaining = fs.readdirSync(dir).filter((n) => /^sessions\.db\.(corrupt|bak)-/.test(n));
        assert.equal(remaining.length, 3, 'open prunes to default keepRecent=3');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
