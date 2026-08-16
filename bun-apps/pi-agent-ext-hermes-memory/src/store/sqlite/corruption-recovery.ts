/**
 * Corruption-recovery for the SQLite memory store — extracted verbatim from
 * sqlite-backend.ts (hermes-arch-06). Every function here was a private
 * SqliteBackend method; the method→function transform is mechanical: drop
 * `this`, and where a body referenced `this.dbPath` the function now takes a
 * leading `dbPath: string` parameter instead.
 *
 * Dependencies are deliberately narrow: node:fs / node:path, SCHEMA_SQL, the
 * RawDatabase constructor + quoteIdentifier helper (imported back from
 * sqlite-backend.js — safe cycle, dereferenced only inside function bodies),
 * and DatabaseLike handles passed in as arguments.
 */
import path from 'node:path';
import fs from 'node:fs';
import { SCHEMA_SQL } from './schema.js';
import { RawDatabase as Database, quoteIdentifier, type DatabaseLike } from './sqlite-backend.js';

export type MovedDatabaseFile = {
  original: string;
  backup: string;
};

export interface DatabaseRecoveryResult {
  strategy: 'rebuilt' | 'recreated-empty';
  backupPaths: string[];
  recoveredRows?: Record<string, number>;
  error?: string;
}

export class DatabaseCorruptionError extends Error {
  code = 'SQLITE_CORRUPT';

  constructor(message: string) {
    super(message);
    this.name = 'DatabaseCorruptionError';
  }
}

const DATABASE_FILE_SUFFIXES: readonly ('' | '-wal' | '-shm')[] = ['', '-wal', '-shm'];
const MEMORY_TARGETS = new Set(['memory', 'user', 'failure']);
const MEMORY_CATEGORIES = new Set(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk']);

/**
 * Single source of truth for the full `memories` column set (22 columns, exact
 * physical order). Used by the corruption-rebuild copy below AND re-imported
 * by SqliteBackend.ensureMemoriesColumns, which derives its idempotent ADD
 * COLUMN list from this order — the two can never drift apart again (that
 * drift is exactly the silent post-rebuild column-drop that 06a/03 FIX 2
 * guards against).
 */
export const MEMORIES_COLUMNS = [
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
  'mw_success',
  'mw_fail',
  'status',
  'supersedes',
  'superseded_by',
  'parent_ids',
  'md_id',
  'state',
  'severity',
  'pin',
  'frontmatter',
  'graph',
] as const;

/** Byte-identical to SqliteBackend.errorMessage — kept module-local here so
 *  recovery's recreated-empty error string matches the class's exactly. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function databaseFileSetExists(dbPath: string): boolean {
  return DATABASE_FILE_SUFFIXES.some((suffix) => fs.existsSync(`${dbPath}${suffix}`));
}

export function assertIntegrityOk(
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

export function assertForeignKeysOk(db: DatabaseLike): void {
  const rows = db.prepare('PRAGMA foreign_key_check').all() as Record<string, unknown>[];
  if (rows.length > 0) {
    throw new Error(`SQLite foreign_key_check failed after rebuild (${rows.length} violation${rows.length === 1 ? '' : 's'})`);
  }
}

export function recoverDatabaseFile(dbPath: string, cause?: unknown): DatabaseRecoveryResult {
  const backupBase = corruptBackupBase(dbPath);
  let rebuildError: unknown;

  if (databaseFileSetExists(dbPath)) {
    try {
      return rebuildDatabaseFromReadableRows(dbPath, backupBase);
    } catch (err) {
      rebuildError = err;
    }
  }

  const moved = moveDatabaseFilesToBackup(dbPath, backupBase);

  return {
    strategy: 'recreated-empty',
    backupPaths: moved.map((file) => file.backup),
    error: errorMessage(rebuildError ?? cause ?? 'unknown corruption'),
  };
}

export function rebuildDatabaseFromReadableRows(dbPath: string, backupBase: string): DatabaseRecoveryResult {
  const tempPath = rebuildTempPath(dbPath);
  removeDatabaseFileSet(tempPath);

  let source: DatabaseLike | null = null;
  let target: DatabaseLike | null = null;
  let recoveredRows: Record<string, number> | undefined;
  let rebuildOk = false;

  try {
    source = new Database(dbPath);
    target = new Database(tempPath);
    target.exec('PRAGMA journal_mode = DELETE');
    target.exec('PRAGMA foreign_keys = OFF');
    target.exec(SCHEMA_SQL);

    recoveredRows = copyRecoverableRows(source, target);
    rebuildFtsTables(target);
    assertForeignKeysOk(target);
    assertIntegrityOk(target, 'quick_check', 'after corruption rebuild');
    rebuildOk = true;
  } finally {
    if (source) safeClose(source);
    if (target) safeClose(target);
    if (!rebuildOk) removeDatabaseFileSet(tempPath);
  }

  const moved = swapRebuiltDatabase(dbPath, tempPath, backupBase);
  removeDatabaseFileSet(tempPath);

  return {
    strategy: 'rebuilt',
    backupPaths: moved.map((file) => file.backup),
    recoveredRows,
  };
}

export function copyRecoverableRows(source: DatabaseLike, target: DatabaseLike): Record<string, number> {
  return {
    extension_metadata: copyExtensionMetadata(source, target),
    sessions: copySessions(source, target),
    messages: copyMessages(source, target),
    session_files: copySessionFiles(source, target),
    memories: copyMemories(source, target),
  };
}

export function copyExtensionMetadata(source: DatabaseLike, target: DatabaseLike): number {
  const insert = target.prepare('INSERT OR REPLACE INTO extension_metadata (key, value) VALUES (?, ?)');
  let copied = 0;

  for (const row of readTableRows(source, 'extension_metadata', ['key', 'value'])) {
    if (typeof row.key !== 'string' || typeof row.value !== 'string') continue;
    insert.run(row.key, row.value);
    copied++;
  }

  return copied;
}

export function copySessions(source: DatabaseLike, target: DatabaseLike): number {
  const insert = target.prepare(`
      INSERT OR IGNORE INTO sessions (id, project, cwd, started_at, ended_at, message_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  let copied = 0;

  for (const row of readTableRows(source, 'sessions', ['id', 'project', 'cwd', 'started_at', 'ended_at', 'message_count'])) {
    if (typeof row.id !== 'string' || typeof row.cwd !== 'string' || typeof row.started_at !== 'string') continue;
    const project = typeof row.project === 'string' && row.project ? row.project : (path.basename(row.cwd) || 'unknown');
    insert.run(
      row.id,
      project,
      row.cwd,
      row.started_at,
      nullableString(row.ended_at),
      integerOr(row.message_count, 0),
    );
    copied++;
  }

  return copied;
}

export function copyMessages(source: DatabaseLike, target: DatabaseLike): number {
  const insert = target.prepare(`
      INSERT OR IGNORE INTO messages (id, session_id, role, content, timestamp, tool_calls)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  let copied = 0;

  for (const row of readTableRows(source, 'messages', ['id', 'session_id', 'role', 'content', 'timestamp', 'tool_calls'])) {
    if (
      typeof row.id !== 'string'
      || typeof row.session_id !== 'string'
      || (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'system')
      || typeof row.content !== 'string'
      || typeof row.timestamp !== 'string'
    ) {
      continue;
    }

    insert.run(row.id, row.session_id, row.role, row.content, row.timestamp, nullableString(row.tool_calls));
    copied++;
  }

  return copied;
}

export function copySessionFiles(source: DatabaseLike, target: DatabaseLike): number {
  const insert = target.prepare(`
      INSERT OR IGNORE INTO session_files (path, session_id, size, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?)
    `);
  let copied = 0;

  for (const row of readTableRows(source, 'session_files', ['path', 'session_id', 'size', 'mtime_ms', 'indexed_at'])) {
    if (typeof row.path !== 'string' || typeof row.session_id !== 'string') continue;
    insert.run(
      row.path,
      row.session_id,
      integerOr(row.size, 0),
      integerOr(row.mtime_ms, 0),
      typeof row.indexed_at === 'string' ? row.indexed_at : new Date(0).toISOString(),
    );
    copied++;
  }

  return copied;
}

export function copyMemories(source: DatabaseLike, target: DatabaseLike): number {
  // 06a/03 FIX 2: the corruption-recovery copy must carry EVERY memories
  // column, or a post-rebuild DB silently drops card data. md_id/state/
  // severity/pin (pre-existing drops) + frontmatter (06a) + graph (03) were
  // previously lost — md_id loss is worst: the rebuilt rows no longer join
  // to the card-store (getCard/md-wins sync all miss) AND unique-id upserts
  // would re-INSERT duplicates. readTableRows filters to columns that exist
  // on the SOURCE, so older DBs (pre-06a) still rebuild fine with defaults.
  // Column list single-sourced from MEMORIES_COLUMNS (hermes-arch-06).
  const insert = target.prepare(`
      INSERT OR IGNORE INTO memories (${MEMORIES_COLUMNS.join(', ')})
      VALUES (${MEMORIES_COLUMNS.map(() => '?').join(', ')})
    `);
  let copied = 0;

  for (const row of readTableRows(source, 'memories', MEMORIES_COLUMNS)) {
    const id = integerOr(row.id, NaN);
    if (!Number.isFinite(id) || typeof row.content !== 'string') continue;

    const targetName = typeof row.target === 'string' && MEMORY_TARGETS.has(row.target) ? row.target : 'memory';
    const category = typeof row.category === 'string' && MEMORY_CATEGORIES.has(row.category) ? row.category : null;
    const created = typeof row.created === 'string' ? row.created : new Date(0).toISOString();
    const lastReferenced = typeof row.last_referenced === 'string' ? row.last_referenced : created;
    const mwSuccess = integerOr(row.mw_success, 0);
    const mwFail = integerOr(row.mw_fail, 0);
    // status defaults to 'active' when absent/invalid (legacy rows backfill);
    // parent_ids is a JSON string carried through verbatim — the caller owns
    // its shape, so we never parse/re-serialize it here.
    const status = typeof row.status === 'string' ? row.status : 'active';
    const supersedes = nullableInteger(row.supersedes);
    const supersededBy = nullableInteger(row.superseded_by);
    const parentIds = nullableString(row.parent_ids);
    // FIX 2: card-store columns (06a/03) carried verbatim — JSON columns are
    // passed through as TEXT (same as parent_ids); the caller owns the shape.
    const mdId = nullableString(row.md_id);
    const state = typeof row.state === 'string' ? row.state : 'active';
    const severity = nullableInteger(row.severity);
    const pin = integerOr(row.pin, 0);
    const frontmatter = nullableString(row.frontmatter);
    const graph = nullableString(row.graph);

    insert.run(
      id,
      nullableString(row.project),
      targetName,
      category,
      row.content,
      nullableString(row.failure_reason),
      nullableString(row.tool_state),
      nullableString(row.corrected_to),
      created,
      lastReferenced,
      mwSuccess,
      mwFail,
      status,
      supersedes,
      supersededBy,
      parentIds,
      mdId,
      state,
      severity,
      pin,
      frontmatter,
      graph,
    );
    copied++;
  }

  return copied;
}

export function readTableRows(source: DatabaseLike, table: string, desiredColumns: readonly string[]): Iterable<Record<string, unknown>> {
  const columns = getColumnNames(source, table);
  const selected = desiredColumns.filter((column) => columns.has(column));
  if (selected.length === 0) return [];

  const sql = `SELECT ${selected.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)} NOT INDEXED`;
  const statement = source.prepare(sql);
  if (statement.iterate) {
    return statement.iterate() as Iterable<Record<string, unknown>>;
  }
  return statement.all() as Record<string, unknown>[];
}

export function getColumnNames(db: DatabaseLike, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as { name?: unknown }[];
  return new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === 'string'));
}

export function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function nullableInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'bigint') return Number(value);
  return null;
}

export function integerOr(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function rebuildFtsTables(db: DatabaseLike): void {
  db.exec("INSERT INTO message_fts(message_fts) VALUES('rebuild')");
  db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
}

export function corruptBackupBase(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const nonce = Math.random().toString(16).slice(2, 8);
  return `${dbPath}.corrupt-${stamp}-${process.pid}-${nonce}`;
}

export function rebuildTempPath(dbPath: string): string {
  const stamp = Date.now();
  const nonce = Math.random().toString(16).slice(2, 8);
  return `${dbPath}.rebuild-${process.pid}-${stamp}-${nonce}.tmp`;
}

export function swapRebuiltDatabase(dbPath: string, tempPath: string, backupBase: string): MovedDatabaseFile[] {
  const moved = moveDatabaseFilesToBackup(dbPath, backupBase);
  try {
    fs.renameSync(tempPath, dbPath);
    return moved;
  } catch (err) {
    restoreMovedDatabaseFiles(moved);
    removeDatabaseFileSet(tempPath);
    throw err;
  }
}

export function moveDatabaseFilesToBackup(dbPath: string, backupBase: string): MovedDatabaseFile[] {
  const moved: MovedDatabaseFile[] = [];
  for (const suffix of DATABASE_FILE_SUFFIXES) {
    const original = `${dbPath}${suffix}`;
    if (!fs.existsSync(original)) continue;

    const backup = `${backupBase}${suffix}`;
    fs.rmSync(backup, { force: true });
    fs.renameSync(original, backup);
    moved.push({ original, backup });
  }
  return moved;
}

export function restoreMovedDatabaseFiles(moved: MovedDatabaseFile[]): void {
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

export function removeDatabaseFileSet(basePath: string): void {
  for (const suffix of DATABASE_FILE_SUFFIXES) {
    fs.rmSync(`${basePath}${suffix}`, { force: true });
  }
}

export function safeClose(db: DatabaseLike): void {
  try { db.close(); } catch { /* best effort */ }
}
