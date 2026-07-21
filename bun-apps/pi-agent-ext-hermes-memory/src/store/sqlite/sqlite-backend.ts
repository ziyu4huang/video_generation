import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { SCHEMA_SQL } from './schema.js';
import type { Backend } from '../repository.js';

type StatementLike = {
  run: (...args: any[]) => any;
  get: (...args: any[]) => any;
  all: (...args: any[]) => any;
  iterate?: (...args: any[]) => Iterable<Record<string, unknown>>;
};

export type DatabaseLike = {
  prepare: (sql: string) => StatementLike;
  exec: (sql: string) => void;
  close: () => void;
  pragma?: (query: string, options?: any) => any;
  transaction?: (fn: any) => any;
};

type DatabaseCtor = new (dbPath: string) => DatabaseLike;
type BunDatabaseInstance = {
  prepare: (sql: string) => StatementLike;
  exec: (sql: string) => void;
  close: (throwOnError?: boolean) => void;
  transaction?: (fn: any) => any;
};

type DatabaseFileSuffix = '' | '-wal' | '-shm';

type MovedDatabaseFile = {
  original: string;
  backup: string;
};

export interface DatabaseRecoveryResult {
  strategy: 'rebuilt' | 'recreated-empty';
  backupPaths: string[];
  recoveredRows?: Record<string, number>;
  error?: string;
}

class DatabaseCorruptionError extends Error {
  code = 'SQLITE_CORRUPT';

  constructor(message: string) {
    super(message);
    this.name = 'DatabaseCorruptionError';
  }
}

export const SQLITE_WAL_AUTOCHECKPOINT_PAGES = 1000;

export const TRANSIENT_DB_RETRY_MAX_ATTEMPTS = 3;
export const TRANSIENT_DB_RETRY_BACKOFF_MS = 50;

/**
 * True for transient SQLite write failures (lock contention / momentary I-O
 * blips) common when multiple processes share the WAL database. These are NOT
 * corruption (SqliteBackend.isCorruptionError + withCorruptionRecovery handle
 * that path) and usually clear on a retry.
 */
export function isTransientDbError(err: unknown): boolean {
  if (!err) return false;
  const code = typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'SQLITE_IOERR') return true;
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return message.includes('disk i/o error')
    || message.includes('database is locked')
    || message.includes('sqlite_busy')
    || message.includes('sqlite_locked')
    || message.includes('sqlite_ioerr');
}

/**
 * Run an operation with a bounded retry on transient (non-corruption) errors.
 * Corruption-class errors are NOT retried here — the caller wraps the operation
 * in withCorruptionRecovery for the rebuild path; this layer only absorbs
 * contention/I-O blips a rebuild cannot fix. `sleep` is injectable for tests.
 */
export async function runWithTransientRetry<T>(
  operation: () => T,
  opts: { maxAttempts?: number; isRetryable?: (err: unknown) => boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? TRANSIENT_DB_RETRY_MAX_ATTEMPTS;
  const isRetryable = opts.isRetryable ?? isTransientDbError;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return operation();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts && isRetryable(err)) {
        await sleep(TRANSIENT_DB_RETRY_BACKOFF_MS * attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr; // unreachable — loop always returns or throws
}

const DATABASE_FILE_SUFFIXES: readonly DatabaseFileSuffix[] = ['', '-wal', '-shm'];
const MEMORY_TARGETS = new Set(['memory', 'user', 'failure']);
const MEMORY_CATEGORIES = new Set(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk']);

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function createBunCompatDatabaseCtor(require: NodeRequire): DatabaseCtor {
  const bunSqlite = require('bun:sqlite') as { Database: new (dbPath: string) => BunDatabaseInstance };

  return class BunCompatDatabase implements DatabaseLike {
    private readonly db: BunDatabaseInstance;

    constructor(dbPath: string) {
      this.db = new bunSqlite.Database(dbPath);
    }

    prepare(sql: string): StatementLike {
      return this.db.prepare(sql);
    }

    exec(sql: string): void {
      this.db.exec(sql);
    }

    close(): void {
      this.db.close();
    }

    transaction(fn: any): any {
      if (!this.db.transaction) {
        return undefined;
      }
      return this.db.transaction(fn);
    }
  };
}

function loadDatabaseCtor(): DatabaseCtor {
  // Bun-only: this package runs under Bun and uses bun:sqlite exclusively.
  // Node/better-sqlite3 support was removed per the project's Bun-only directive
  // (PR follow-up to #460). The BunCompatDatabase class normalizes bun:sqlite's
  // API to the shape the rest of the codebase expects.
  const require = createRequire(import.meta.url);
  return createBunCompatDatabaseCtor(require);
}

const Database = loadDatabaseCtor();

/** The SQLite Database constructor (bun:sqlite, wrapped by BunCompatDatabase
 *  to normalize its API). Exported so tests and tooling can create raw databases
 *  without importing bun:sqlite directly. */
export { Database as RawDatabase };

export class SqliteBackend implements Backend {
  private db: DatabaseLike | null = null;
  private readonly dbPath: string;
  private lastRecovery: DatabaseRecoveryResult | null = null;

  constructor(memoryDir: string) {
    this.dbPath = path.join(memoryDir, 'sessions.db');
  }

  /**
   * True when an error indicates SQLite file/page corruption rather than a
   * normal constraint, migration, or query failure.
   */
  static isCorruptionError(err: unknown): boolean {
    if (!err) return false;

    const code = typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
    if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') return true;

    const message = SqliteBackend.errorMessage(err).toLowerCase();
    return message.includes('database disk image is malformed')
      || message.includes('file is not a database')
      || message.includes('database schema is corrupt')
      || message.includes('malformed database schema')
      || message.includes('btreeinitpage')
      || message.includes('sqlite_corrupt')
      || message.includes('sqlite_notadb');
  }

  private static errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }

  /**
   * Get the database instance. Creates/opens on first call.
   */
  getDb(): DatabaseLike {
    if (!this.db) {
      this.db = this.open();
    }
    return this.db;
  }

  /**
   * Last self-heal performed by this manager, if any. Exposed for diagnostics
   * and tests; normal callers do not need it.
   */
  getLastRecovery(): DatabaseRecoveryResult | null {
    return this.lastRecovery;
  }

  /**
   * Retry a DB operation once after quarantining/rebuilding a corrupt DB.
   */
  withCorruptionRecovery<T>(operation: () => T): T {
    try {
      return operation();
    } catch (err) {
      if (!SqliteBackend.isCorruptionError(err)) {
        throw err;
      }
      this.recoverFromCorruption(err);
      return operation();
    }
  }

  /**
   * Close any open handle, rebuild/quarantine the DB file set, and let the next
   * getDb() reopen a clean database.
   */
  recoverFromCorruption(cause?: unknown): DatabaseRecoveryResult {
    this.close();
    const recovery = this.recoverDatabaseFile(cause);
    this.lastRecovery = recovery;
    return recovery;
  }

  /**
   * Open the database and initialize schema.
   */
  private open(): DatabaseLike {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let db: DatabaseLike;
    try {
      db = this.openUnchecked();
    } catch (err) {
      if (!SqliteBackend.isCorruptionError(err)) {
        throw err;
      }

      const recovery = this.recoverDatabaseFile(err);
      this.lastRecovery = recovery;
      db = this.openUnchecked();
    }

    // Best-effort: prune accumulated quarantine/backup clutter so a self-heal
    // storm (or repeated consolidate/dedup runs) can't grow the memory dir
    // without bound. Never fatal — a failed prune must not break the DB open.
    this.pruneStaleBackups();
    return db;
  }

  private openUnchecked(): DatabaseLike {
    const existed = this.hasExistingMainDatabaseFile();
    const db = new Database(this.dbPath);
    let ok = false;

    try {
      if (existed) {
        this.assertIntegrityOk(db, 'quick_check', 'before schema initialization');
      }

      this.configureConnection(db);
      this.initializeSchema(db);
      this.assertIntegrityOk(db, 'quick_check', 'after schema initialization');
      ok = true;
      return db;
    } finally {
      if (!ok) {
        this.safeClose(db);
      }
    }
  }

  private configureConnection(db: DatabaseLike): void {
    // Enable WAL mode + FK enforcement for each connection. Keep SQLite's
    // default WAL autocheckpoint size; a very aggressive checkpoint cadence
    // increases the chance that abrupt VM/host shutdown catches a checkpoint.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`PRAGMA wal_autocheckpoint = ${SQLITE_WAL_AUTOCHECKPOINT_PAGES}`);
    db.exec('PRAGMA journal_size_limit = 5242880');
    db.exec('PRAGMA foreign_keys = ON');
    // Multiple connections open the same DB file (the extension singleton plus
    // short-lived child `pi -p` processes that reload this extension, and the
    // /memory-index-sessions command). Under WAL only one writer is allowed at
    // a time; without a busy timeout the second writer receives SQLITE_BUSY
    // immediately instead of waiting. 5s is well above any normal write and
    // cheap because it only elapses on actual contention.
    db.exec('PRAGMA busy_timeout = 5000');
  }

  private initializeSchema(db: DatabaseLike): void {
    // Create tables and triggers
    try {
      db.exec(SCHEMA_SQL);
    } catch (err) {
      if (!this.isLegacySchemaError(err)) {
        throw err;
      }

      // Legacy DBs can be missing v0.6 failure-memory columns and/or the project
      // column on sessions/memories. Add missing columns, then retry schema.
      this.ensureLegacySchemaColumns(db);
      db.exec(SCHEMA_SQL);
    }

    // Extra safety: always ensure legacy columns exist, then migrate legacy
    // CHECK(target IN ('memory','user')) constraints to include 'failure'.
    this.ensureLegacySchemaColumns(db);
    this.migrateLegacyMemoriesTargetConstraint(db);
    this.rebuildMemoryFts(db);
  }

  private hasExistingMainDatabaseFile(): boolean {
    try {
      return fs.existsSync(this.dbPath) && fs.statSync(this.dbPath).size > 0;
    } catch {
      return false;
    }
  }

  private databaseFileSetExists(): boolean {
    return DATABASE_FILE_SUFFIXES.some((suffix) => fs.existsSync(`${this.dbPath}${suffix}`));
  }

  private assertIntegrityOk(
    db: DatabaseLike,
    check: 'quick_check' | 'integrity_check' = 'quick_check',
    context = '',
  ): void {
    const rows = db.prepare(`PRAGMA ${check}`).all() as Record<string, unknown>[];
    const messages = rows.map((row) => String(Object.values(row)[0] ?? ''));
    const failures = messages.filter((message) => message.toLowerCase() !== 'ok');

    if (rows.length === 0 || failures.length > 0) {
      const detail = failures.length > 0 ? failures.slice(0, 5).join('\n') : 'no result rows';
      const suffix = context ? ` ${context}` : '';
      throw new DatabaseCorruptionError(`SQLite ${check} failed${suffix}: ${detail}`);
    }
  }

  private assertForeignKeysOk(db: DatabaseLike): void {
    const rows = db.prepare('PRAGMA foreign_key_check').all() as Record<string, unknown>[];
    if (rows.length > 0) {
      throw new Error(`SQLite foreign_key_check failed after rebuild (${rows.length} violation${rows.length === 1 ? '' : 's'})`);
    }
  }

  private recoverDatabaseFile(cause?: unknown): DatabaseRecoveryResult {
    const backupBase = this.corruptBackupBase();
    let rebuildError: unknown;

    if (this.databaseFileSetExists()) {
      try {
        return this.rebuildDatabaseFromReadableRows(backupBase);
      } catch (err) {
        rebuildError = err;
      }
    }

    const moved = this.moveDatabaseFilesToBackup(backupBase);
    return {
      strategy: 'recreated-empty',
      backupPaths: moved.map((file) => file.backup),
      error: SqliteBackend.errorMessage(rebuildError ?? cause ?? 'unknown corruption'),
    };
  }

  private rebuildDatabaseFromReadableRows(backupBase: string): DatabaseRecoveryResult {
    const tempPath = this.rebuildTempPath();
    this.removeDatabaseFileSet(tempPath);

    let source: DatabaseLike | null = null;
    let target: DatabaseLike | null = null;
    let recoveredRows: Record<string, number> | undefined;
    let rebuildOk = false;

    try {
      source = new Database(this.dbPath);
      target = new Database(tempPath);
      target.exec('PRAGMA journal_mode = DELETE');
      target.exec('PRAGMA foreign_keys = OFF');
      target.exec(SCHEMA_SQL);

      recoveredRows = this.copyRecoverableRows(source, target);
      this.rebuildFtsTables(target);
      this.assertForeignKeysOk(target);
      this.assertIntegrityOk(target, 'quick_check', 'after corruption rebuild');
      rebuildOk = true;
    } finally {
      if (source) this.safeClose(source);
      if (target) this.safeClose(target);
      if (!rebuildOk) this.removeDatabaseFileSet(tempPath);
    }

    const moved = this.swapRebuiltDatabase(tempPath, backupBase);
    this.removeDatabaseFileSet(tempPath);

    return {
      strategy: 'rebuilt',
      backupPaths: moved.map((file) => file.backup),
      recoveredRows,
    };
  }

  private copyRecoverableRows(source: DatabaseLike, target: DatabaseLike): Record<string, number> {
    return {
      extension_metadata: this.copyExtensionMetadata(source, target),
      sessions: this.copySessions(source, target),
      messages: this.copyMessages(source, target),
      session_files: this.copySessionFiles(source, target),
      memories: this.copyMemories(source, target),
    };
  }

  private copyExtensionMetadata(source: DatabaseLike, target: DatabaseLike): number {
    const insert = target.prepare('INSERT OR REPLACE INTO extension_metadata (key, value) VALUES (?, ?)');
    let copied = 0;

    for (const row of this.readTableRows(source, 'extension_metadata', ['key', 'value'])) {
      if (typeof row.key !== 'string' || typeof row.value !== 'string') continue;
      insert.run(row.key, row.value);
      copied++;
    }

    return copied;
  }

  private copySessions(source: DatabaseLike, target: DatabaseLike): number {
    const insert = target.prepare(`
      INSERT OR IGNORE INTO sessions (id, project, cwd, started_at, ended_at, message_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    let copied = 0;

    for (const row of this.readTableRows(source, 'sessions', ['id', 'project', 'cwd', 'started_at', 'ended_at', 'message_count'])) {
      if (typeof row.id !== 'string' || typeof row.cwd !== 'string' || typeof row.started_at !== 'string') continue;
      const project = typeof row.project === 'string' && row.project ? row.project : (path.basename(row.cwd) || 'unknown');
      insert.run(
        row.id,
        project,
        row.cwd,
        row.started_at,
        this.nullableString(row.ended_at),
        this.integerOr(row.message_count, 0),
      );
      copied++;
    }

    return copied;
  }

  private copyMessages(source: DatabaseLike, target: DatabaseLike): number {
    const insert = target.prepare(`
      INSERT OR IGNORE INTO messages (id, session_id, role, content, timestamp, tool_calls)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    let copied = 0;

    for (const row of this.readTableRows(source, 'messages', ['id', 'session_id', 'role', 'content', 'timestamp', 'tool_calls'])) {
      if (
        typeof row.id !== 'string'
        || typeof row.session_id !== 'string'
        || (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'system')
        || typeof row.content !== 'string'
        || typeof row.timestamp !== 'string'
      ) {
        continue;
      }

      insert.run(row.id, row.session_id, row.role, row.content, row.timestamp, this.nullableString(row.tool_calls));
      copied++;
    }

    return copied;
  }

  private copySessionFiles(source: DatabaseLike, target: DatabaseLike): number {
    const insert = target.prepare(`
      INSERT OR IGNORE INTO session_files (path, session_id, size, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    let copied = 0;

    for (const row of this.readTableRows(source, 'session_files', ['path', 'session_id', 'size', 'mtime_ms', 'indexed_at'])) {
      if (typeof row.path !== 'string' || typeof row.session_id !== 'string') continue;
      insert.run(
        row.path,
        row.session_id,
        this.integerOr(row.size, 0),
        this.integerOr(row.mtime_ms, 0),
        typeof row.indexed_at === 'string' ? row.indexed_at : new Date(0).toISOString(),
      );
      copied++;
    }

    return copied;
  }

  private copyMemories(source: DatabaseLike, target: DatabaseLike): number {
    const insert = target.prepare(`
      INSERT OR IGNORE INTO memories (id, project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let copied = 0;

    for (const row of this.readTableRows(source, 'memories', [
      'id',
      'project',
      'target',
      'category',
      'content',
      'failure_reason',
      'tool_state',
      'corrected_to',
      'created',
      'last_referenced',
    ])) {
      const id = this.integerOr(row.id, NaN);
      if (!Number.isFinite(id) || typeof row.content !== 'string') continue;

      const targetName = typeof row.target === 'string' && MEMORY_TARGETS.has(row.target) ? row.target : 'memory';
      const category = typeof row.category === 'string' && MEMORY_CATEGORIES.has(row.category) ? row.category : null;
      const created = typeof row.created === 'string' ? row.created : new Date(0).toISOString();
      const lastReferenced = typeof row.last_referenced === 'string' ? row.last_referenced : created;

      insert.run(
        id,
        this.nullableString(row.project),
        targetName,
        category,
        row.content,
        this.nullableString(row.failure_reason),
        this.nullableString(row.tool_state),
        this.nullableString(row.corrected_to),
        created,
        lastReferenced,
      );
      copied++;
    }

    return copied;
  }

  private readTableRows(source: DatabaseLike, table: string, desiredColumns: string[]): Iterable<Record<string, unknown>> {
    const columns = this.getColumnNames(source, table);
    const selected = desiredColumns.filter((column) => columns.has(column));
    if (selected.length === 0) return [];

    const sql = `SELECT ${selected.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)} NOT INDEXED`;
    const statement = source.prepare(sql);
    if (statement.iterate) {
      return statement.iterate() as Iterable<Record<string, unknown>>;
    }
    return statement.all() as Record<string, unknown>[];
  }

  private getColumnNames(db: DatabaseLike, table: string): Set<string> {
    const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as { name?: unknown }[];
    return new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === 'string'));
  }

  private nullableString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private integerOr(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
  }

  private rebuildFtsTables(db: DatabaseLike): void {
    db.exec("INSERT INTO message_fts(message_fts) VALUES('rebuild')");
    db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
  }

  private corruptBackupBase(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const nonce = Math.random().toString(16).slice(2, 8);
    return `${this.dbPath}.corrupt-${stamp}-${process.pid}-${nonce}`;
  }

  private rebuildTempPath(): string {
    const stamp = Date.now();
    const nonce = Math.random().toString(16).slice(2, 8);
    return `${this.dbPath}.rebuild-${process.pid}-${stamp}-${nonce}.tmp`;
  }

  private swapRebuiltDatabase(tempPath: string, backupBase: string): MovedDatabaseFile[] {
    const moved = this.moveDatabaseFilesToBackup(backupBase);
    try {
      fs.renameSync(tempPath, this.dbPath);
      return moved;
    } catch (err) {
      this.restoreMovedDatabaseFiles(moved);
      this.removeDatabaseFileSet(tempPath);
      throw err;
    }
  }

  private moveDatabaseFilesToBackup(backupBase: string): MovedDatabaseFile[] {
    const moved: MovedDatabaseFile[] = [];
    for (const suffix of DATABASE_FILE_SUFFIXES) {
      const original = `${this.dbPath}${suffix}`;
      if (!fs.existsSync(original)) continue;

      const backup = `${backupBase}${suffix}`;
      fs.rmSync(backup, { force: true });
      fs.renameSync(original, backup);
      moved.push({ original, backup });
    }
    return moved;
  }

  private restoreMovedDatabaseFiles(moved: MovedDatabaseFile[]): void {
    for (const file of [...moved].reverse()) {
      try {
        if (!fs.existsSync(file.backup)) continue;
        fs.rmSync(file.original, { force: true });
        fs.renameSync(file.backup, file.original);
      } catch {
        // Best effort. The backup path remains available if restoration fails.
      }
    }
  }

  private removeDatabaseFileSet(basePath: string): void {
    for (const suffix of DATABASE_FILE_SUFFIXES) {
      fs.rmSync(`${basePath}${suffix}`, { force: true });
    }
  }

  private safeClose(db: DatabaseLike): void {
    try { db.close(); } catch { /* best effort */ }
  }

  private isLegacySchemaError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes('no such column: category')
      || msg.includes('memories(category)')
      || msg.includes('no such column: project')
      || msg.includes('sessions(project)')
      || msg.includes('memories(project)');
  }

  private ensureLegacySchemaColumns(db: DatabaseLike): void {
    this.ensureMemoriesColumns(db);
    this.ensureSessionsColumns(db);
  }

  private ensureMemoriesColumns(db: DatabaseLike): void {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'").get() as { name: string } | undefined;
    if (!tableExists) return;

    const names = this.getColumnNames(db, 'memories');

    if (!names.has('project')) {
      db.exec('ALTER TABLE memories ADD COLUMN project TEXT');
    }
    if (!names.has('category')) {
      db.exec('ALTER TABLE memories ADD COLUMN category TEXT');
    }
    if (!names.has('failure_reason')) {
      db.exec('ALTER TABLE memories ADD COLUMN failure_reason TEXT');
    }
    if (!names.has('tool_state')) {
      db.exec('ALTER TABLE memories ADD COLUMN tool_state TEXT');
    }
    if (!names.has('corrected_to')) {
      db.exec('ALTER TABLE memories ADD COLUMN corrected_to TEXT');
    }
  }

  private ensureSessionsColumns(db: DatabaseLike): void {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get() as { name: string } | undefined;
    if (!tableExists) return;

    const names = this.getColumnNames(db, 'sessions');
    if (!names.has('project')) {
      db.exec('ALTER TABLE sessions ADD COLUMN project TEXT');
    }

    this.backfillSessionsProject(db);
  }

  private backfillSessionsProject(db: DatabaseLike): void {
    const names = this.getColumnNames(db, 'sessions');
    if (!names.has('project') || !names.has('cwd') || !names.has('id')) return;

    const rows = db.prepare('SELECT id, cwd, project FROM sessions').all() as Array<{
      id?: unknown;
      cwd?: unknown;
      project?: unknown;
    }>;
    const update = db.prepare('UPDATE sessions SET project = ? WHERE id = ?');

    for (const row of rows) {
      if (typeof row.id !== 'string') continue;
      if (typeof row.project === 'string' && row.project.trim()) continue;

      const project = typeof row.cwd === 'string' && row.cwd.trim()
        ? (path.basename(row.cwd) || 'unknown')
        : 'unknown';
      update.run(project, row.id);
    }
  }

  private migrateLegacyMemoriesTargetConstraint(db: DatabaseLike): void {
    const tableSqlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'").get() as { sql?: string } | undefined;
    const tableSql = tableSqlRow?.sql ?? '';
    if (!tableSql) return;

    // Legacy schema allowed only memory/user. New schema must allow failure too.
    const hasLegacyTargetCheck = /target\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*target\s+IN\s*\(\s*'memory'\s*,\s*'user'\s*\)\s*\)/i.test(tableSql);
    if (!hasLegacyTargetCheck) return;

    if (!db.transaction) {
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.exec('BEGIN IMMEDIATE');
        db.exec(`
          CREATE TABLE memories_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT,
            target TEXT NOT NULL CHECK (target IN ('memory', 'user', 'failure')),
            category TEXT CHECK (category IN ('failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk')),
            content TEXT NOT NULL,
            failure_reason TEXT,
            tool_state TEXT,
            corrected_to TEXT,
            created DATE NOT NULL,
            last_referenced DATE NOT NULL
          );
        `);

        db.exec(`
          INSERT INTO memories_new (id, project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
          SELECT id, project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced
          FROM memories;
        `);

        db.exec('DROP TABLE memories');
        db.exec('ALTER TABLE memories_new RENAME TO memories');
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
      return;
    }

    const tx = db.transaction(() => {
      db.exec(`
        CREATE TABLE memories_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT,
          target TEXT NOT NULL CHECK (target IN ('memory', 'user', 'failure')),
          category TEXT CHECK (category IN ('failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk')),
          content TEXT NOT NULL,
          failure_reason TEXT,
          tool_state TEXT,
          corrected_to TEXT,
          created DATE NOT NULL,
          last_referenced DATE NOT NULL
        );
      `);

      db.exec(`
          INSERT INTO memories_new (id, project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced)
          SELECT id, project, target, category, content, failure_reason, tool_state, corrected_to, created, last_referenced
          FROM memories;
        `);

      db.exec('DROP TABLE memories');
      db.exec('ALTER TABLE memories_new RENAME TO memories');
    });

    db.exec('PRAGMA foreign_keys = OFF');
    try {
      tx();
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  private rebuildMemoryFts(db: DatabaseLike): void {
    const ftsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'").get() as { name?: string } | undefined;
    if (!ftsTable) return;

    // Keep FTS index consistent after table rebuild/migrations.
    db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
  }

  /**
   * Initialize the backend: open the database and set up the schema. Satisfies
   * the Backend interface. Idempotent — the lazy getDb() already guards re-entry.
   */
  async init(): Promise<void> {
    this.getDb(); // triggers open() + schema init lazily, same as today
  }

  /**
   * Verify backend health. Runs PRAGMA quick_check and throws if the database is
   * not ok — mirrors the existing assertIntegrityOk logic.
   */
  async healthCheck(): Promise<void> {
    const db = this.getDb();
    const rows = db.prepare('PRAGMA quick_check').all() as Record<string, unknown>[];
    const ok = rows.length > 0 && String(Object.values(rows[0])[0] ?? '').toLowerCase() === 'ok';
    if (!ok) {
      throw new Error('SQLite quick_check failed');
    }
  }

  /**
   * Close the database connection.
   *
   * The body is fully synchronous (no await inside): PRAGMA wal_checkpoint and
   * db.close() run before the returned promise resolves, so callers that invoke
   * `backend.close()` WITHOUT await (tests teardown, index.ts) still observe the
   * full sync effect immediately. The async signature satisfies Backend.close()
   * honestly without requiring an adapter.
   */
  async close(): Promise<void> {
    if (this.db) {
      try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
      try { this.db.close(); } catch { /* best effort — close may throw on a corrupt handle */ }
      this.db = null;
    }
  }

  /**
   * Get the database file path.
   */
  getPath(): string {
    return this.dbPath;
  }

  /**
   * Check if the database file exists.
   */
  exists(): boolean {
    return fs.existsSync(this.dbPath);
  }

  /**
   * Get stats about the database.
   */
  getStats(): { sessions: number; messages: number; memories: number } {
    const db = this.getDb();
    const sessions = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
    const messages = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
    const memories = db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number };
    return {
      sessions: sessions.count,
      messages: messages.count,
      memories: memories.count,
    };
  }

  /** Default number of newest quarantine/backup files pruneStaleBackups keeps. */
  static readonly PRUNE_KEEP_RECENT_DEFAULT = 3;

  /**
   * Best-effort cleanup of accumulated quarantine/backup files left beside the
   * database by corruption self-heal (.corrupt-*) and consolidate/dedup runs
   * (.bak-*), plus leaked rebuild temps (.rebuild-*.tmp). Keeps the
   * `keepRecent` (default 3) newest such files and deletes the rest. NEVER
   * touches the live sessions.db / -wal / -shm. Safe to call from every open:
   * concurrent processes racing on readdir/rmSync only ever no-op on files the
   * other already removed (rmSync force:true is idempotent). Returns the names
   * of deleted files (for diagnostics/tests).
   */
  pruneStaleBackups(opts: { keepRecent?: number } = {}): string[] {
    const keepRecent = opts.keepRecent ?? SqliteBackend.PRUNE_KEEP_RECENT_DEFAULT;
    const dir = path.dirname(this.dbPath);
    const base = path.basename(this.dbPath);

    let entries: { name: string; mtimeMs: number }[] = [];
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name === base || name === `${base}-wal` || name === `${base}-shm`) continue;
        if (!name.startsWith(`${base}.`)) continue;
        const rest = name.slice(base.length + 1);
        if (!/^(corrupt-|bak-|rebuild-.*\.tmp$)/.test(rest)) continue;
        try {
          const st = fs.statSync(path.join(dir, name));
          entries.push({ name, mtimeMs: st.mtimeMs });
        } catch {
          /* unreadable entry — skip */
        }
      }
    } catch {
      return [];
    }

    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const deleted: string[] = [];
    for (const entry of entries.slice(keepRecent)) {
      try {
        fs.rmSync(path.join(dir, entry.name), { force: true });
        deleted.push(entry.name);
      } catch {
        /* best effort */
      }
    }
    return deleted;
  }
}

/**
 * Deprecated alias for in-flight code/tests during the backend-abstraction
 * refactor. Removed in Task 8 cleanup. New code should import SqliteBackend.
 * Both a value alias (class identity) and a type alias (instance type) are
 * exported so existing usages of `DatabaseManager` as either a value or a type
 * annotation continue to resolve during the transition.
 */
export const DatabaseManager = SqliteBackend;
export type DatabaseManager = SqliteBackend;
