import fs from 'node:fs';
import { DatabaseManager, type DatabaseLike } from './sqlite/sqlite-backend.js';
import { parseSessionFile, getSessionFiles, type ParsedSession } from './session-parser.js';

export const LAST_SESSION_BACKFILL_KEY = 'last_session_backfill';
export const SESSION_BACKFILL_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Index result for a single session.
 */
export interface IndexResult {
  sessionId: string;
  messagesIndexed: number;
  skipped: boolean; // true if the session already existed and no new messages were indexed
}

/**
 * Bulk index result.
 */
export interface BulkIndexResult {
  sessionsProcessed: number;
  sessionsIndexed: number;
  sessionsSkipped: number;
  messagesIndexed: number;
  errors: string[];
  reachedLimit?: boolean;
}

interface SessionFileMetadata {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface IncrementalIndexOptions {
  projectDir?: string;
  maxFilesToIndex?: number;
}

/**
 * Index a single session into the database.
 *
 * @returns IndexResult with count of messages indexed
 */
export function indexSession(dbManager: DatabaseManager, session: ParsedSession): IndexResult {
  return dbManager.withCorruptionRecovery(() => indexSessionOnce(dbManager, session));
}

/**
 * Write one session's rows (session upsert + message inserts + count sync).
 * Transaction-free: callers manage transaction boundaries. Extracted so the
 * bulk indexing path can batch many sessions into a SINGLE transaction
 * (10-50× fewer fsyncs than one transaction per session).
 */
function writeSessionToDb(db: DatabaseLike, session: ParsedSession): void {
  const insertSession = db.prepare(`
    INSERT OR IGNORE INTO sessions (id, project, cwd, started_at, ended_at, message_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMsg = db.prepare(`
    INSERT OR IGNORE INTO messages (id, session_id, role, content, timestamp, tool_calls)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const updateSession = db.prepare(`
    UPDATE sessions
    SET project = ?,
        cwd = ?,
        ended_at = COALESCE(?, ended_at),
        message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?)
    WHERE id = ?
  `);

  insertSession.run(
    session.id,
    session.project,
    session.cwd,
    session.startedAt,
    session.endedAt,
    session.messages.length
  );

  for (const msg of session.messages) {
    insertMsg.run(
      msg.id,
      session.id,
      msg.role,
      msg.content,
      msg.timestamp,
      msg.toolCalls ? JSON.stringify(msg.toolCalls) : null
    );
  }

  updateSession.run(session.project, session.cwd, session.endedAt, session.id, session.id);
}

function indexSessionOnce(dbManager: DatabaseManager, session: ParsedSession): IndexResult {
  const db = dbManager.getDb();

  const existingSession = db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id) as { id: string } | undefined;
  const before = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(session.id) as { count: number };

  const write = () => writeSessionToDb(db, session);

  if (db.transaction) {
    const tx = db.transaction(write);
    tx();
  } else {
    write();
  }

  const after = db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(session.id) as { count: number };
  const messagesIndexed = after.count - before.count;

  return { sessionId: session.id, messagesIndexed, skipped: Boolean(existingSession) && messagesIndexed === 0 };
}

type SessionManagerSnapshot = {
  getHeader: () => { id: string; timestamp: string; cwd: string } | null;
  getEntries: () => unknown[];
  getSessionFile?: () => string | undefined;
};

type SessionMessageEntryLike = {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
  };
};

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;

    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string') parts.push(b.text);
        break;
      case 'tool_result':
        if (typeof b.content === 'string') {
          parts.push(b.content);
        } else if (Array.isArray(b.content)) {
          for (const item of b.content) {
            if (item && typeof item === 'object' && (item as Record<string, unknown>).type === 'text') {
              const text = (item as Record<string, unknown>).text;
              if (typeof text === 'string') parts.push(text);
            }
          }
        }
        break;
    }
  }

  return parts.join('\n').trim();
}

function extractToolCalls(content: unknown): string[] | undefined {
  if (!Array.isArray(content)) return undefined;

  const toolNames: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if ((b.type === 'toolCall' || b.type === 'tool_use') && typeof b.name === 'string') {
      toolNames.push(b.name);
    }
  }
  return toolNames.length > 0 ? toolNames : undefined;
}

function parseMessageEntry(entry: unknown): ParsedSession['messages'][number] | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as SessionMessageEntryLike;
  if (e.type !== 'message' || typeof e.id !== 'string' || typeof e.timestamp !== 'string' || !e.message) return null;

  const role = e.message.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'system') return null;

  const content = extractTextContent(e.message.content);
  if (!content) return null;

  return {
    id: e.id,
    role,
    content,
    timestamp: e.timestamp,
    toolCalls: role === 'assistant' ? extractToolCalls(e.message.content) : undefined,
  };
}

export function parseSessionManagerSnapshot(sessionManager: SessionManagerSnapshot): ParsedSession | null {
  const header = sessionManager.getHeader();
  if (!header?.id || !header.cwd || !header.timestamp) return null;

  const messages = sessionManager.getEntries()
    .map(parseMessageEntry)
    .filter((msg): msg is ParsedSession['messages'][number] => msg !== null);

  return {
    id: header.id,
    project: header.cwd.split('/').pop() ?? header.cwd,
    cwd: header.cwd,
    startedAt: header.timestamp,
    endedAt: null,
    messages,
  };
}

export function indexCurrentSession(dbManager: DatabaseManager, sessionManager: SessionManagerSnapshot): IndexResult | null {
  const session = parseSessionManagerSnapshot(sessionManager);
  if (!session) return null;
  return indexSession(dbManager, session);
}

export function indexLiveSession(dbManager: DatabaseManager, sessionManager: SessionManagerSnapshot): IndexResult | null {
  return dbManager.withCorruptionRecovery(() => indexLiveSessionOnce(dbManager, sessionManager));
}

function indexLiveSessionOnce(dbManager: DatabaseManager, sessionManager: SessionManagerSnapshot): IndexResult | null {
  const sessionFile = sessionManager.getSessionFile?.();
  if (sessionFile && fs.existsSync(sessionFile)) {
    const session = parseSessionFile(sessionFile);
    if (session) {
      const result = indexSession(dbManager, session);
      upsertSessionFileMetadata(dbManager, sessionFile, session.id);
      return result;
    }
  }

  return indexCurrentSession(dbManager, sessionManager);
}

function getSessionFileMetadata(filePath: string): SessionFileMetadata {
  const stat = fs.statSync(filePath);
  return { path: filePath, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
}

function getStoredSessionFileMetadata(dbManager: DatabaseManager, filePath: string): { size: number; mtime_ms: number } | undefined {
  return dbManager.getDb().prepare('SELECT size, mtime_ms FROM session_files WHERE path = ?').get(filePath) as { size: number; mtime_ms: number } | undefined;
}

function storedSessionFileMatches(dbManager: DatabaseManager, metadata: SessionFileMetadata): boolean {
  const row = getStoredSessionFileMetadata(dbManager, metadata.path);
  return Boolean(row && row.size === metadata.size && row.mtime_ms === metadata.mtimeMs);
}

export function upsertSessionFileMetadata(
  dbManager: DatabaseManager,
  filePath: string,
  sessionId: string,
  metadata = getSessionFileMetadata(filePath),
  indexedAt = new Date(),
): void {
  const db = dbManager.getDb();
  db.prepare(`
    INSERT INTO session_files (path, session_id, size, mtime_ms, indexed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      session_id = excluded.session_id,
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      indexed_at = excluded.indexed_at
  `).run(metadata.path, sessionId, metadata.size, metadata.mtimeMs, indexedAt.toISOString());
}

function emptyBulkIndexResult(): BulkIndexResult {
  return {
    sessionsProcessed: 0,
    sessionsIndexed: 0,
    sessionsSkipped: 0,
    messagesIndexed: 0,
    errors: [],
  };
}

function indexSessionFile(dbManager: DatabaseManager, file: string, result: BulkIndexResult): void {
  result.sessionsProcessed++;

  const session = parseSessionFile(file);
  if (!session) {
    result.errors.push(`Failed to parse: ${file}`);
    return;
  }

  const indexResult = indexSession(dbManager, session);
  upsertSessionFileMetadata(dbManager, file, session.id);
  if (indexResult.skipped) {
    result.sessionsSkipped++;
  } else {
    result.sessionsIndexed++;
    result.messagesIndexed += indexResult.messagesIndexed;
  }
}

/**
 * Index all sessions from disk.
 *
 * @param dbManager — Database manager instance
 * @param sessionsDir — Path to ~/.pi/agent/sessions/
 * @param projectDir — Optional: specific project directory to index
 * @returns Bulk index result
 */
export function indexAllSessions(
  dbManager: DatabaseManager,
  sessionsDir: string,
  projectDir?: string
): BulkIndexResult {
  const files = getSessionFiles(sessionsDir, projectDir);
  const result = emptyBulkIndexResult();

  // ONE transaction for the whole batch. Each session is isolated by a nested
  // SAVEPOINT (see runBulkIndexInTx), so a single bad session rolls back only
  // itself — but all surviving sessions commit together in a single fsync.
  dbManager.withCorruptionRecovery(() => runBulkIndexInTx(dbManager, files, result));

  return result;
}

/**
 * Incrementally index session JSONL files without matching stored metadata.
 *
 * This is intentionally cheaper than indexAllSessions() for startup backfill:
 * files with matching stored size/mtime metadata are skipped, and all other
 * files are parsed under the startup cap.
 */
export function indexChangedSessions(
  dbManager: DatabaseManager,
  sessionsDir: string,
  options: IncrementalIndexOptions = {},
): BulkIndexResult {
  const files = getSessionFiles(sessionsDir, options.projectDir);
  const maxFilesToIndex = options.maxFilesToIndex ?? 50;
  const result = emptyBulkIndexResult();

  // Gather the changed set first, then sort newest-first before applying the
  // cap. Crash recovery is the primary value of startup backfill (the live
  // message_end path missed the session's final state), and crashed sessions
  // are the most recently modified files. Sorting newest-first ensures they
  // are indexed on the very next startup instead of waiting behind old
  // historical files that fill the per-startup cap in filesystem order.
  const changed: SessionFileMetadata[] = [];
  for (const file of files) {
    try {
      const metadata = getSessionFileMetadata(file);
      if (storedSessionFileMatches(dbManager, metadata)) {
        result.sessionsSkipped++;
        continue;
      }
      changed.push(metadata);
    } catch (err) {
      result.errors.push(`Error indexing ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  changed.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // Apply the startup cap by COUNT before entering the batch transaction. The
  // cap limits parsed+indexed files (not metadata-skipped ones); selecting the
  // prefix by length preserves the original live-counter semantics while
  // letting all selected files share one transaction.
  const toIndex: string[] = [];
  for (const metadata of changed) {
    if (toIndex.length >= maxFilesToIndex) {
      result.reachedLimit = true;
      break;
    }
    toIndex.push(metadata.path);
  }

  dbManager.withCorruptionRecovery(() => runBulkIndexInTx(dbManager, toIndex, result));

  return result;
}

/**
 * Bulk-index `files` inside a SINGLE outer transaction with per-session
 * SAVEPOINT isolation.
 *
 * Why one transaction: SQLite commits force a WAL sync; committing once per
 * session over N files is N fsyncs (the documented 10-50× SQLite anti-pattern).
 * Why per-session SAVEPOINTs: a DB error in one session must roll back only
 * that session so the rest of the batch survives. Corruption errors escape to
 * the caller's `withCorruptionRecovery` (rebuild + retry the whole batch).
 */
function runBulkIndexInTx(dbManager: DatabaseManager, files: string[], result: BulkIndexResult): void {
  const db = dbManager.getDb();

  if (!db.transaction) {
    // Runtime without transaction support — fall back to the legacy per-session
    // path (each session commits independently).
    for (const file of files) {
      try {
        indexSessionFile(dbManager, file, result);
      } catch (err) {
        result.errors.push(`Error indexing ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return;
  }

  const runBatch = db.transaction(() => {
    for (const file of files) {
      try {
        indexSessionFileInTx(db, dbManager, file, result);
      } catch (err) {
        // Corruption must reach the outer withCorruptionRecovery (rebuild +
        // retry the whole batch); all other per-session errors are logged and
        // the batch continues — the SAVEPOINT already rolled back the failing
        // session's writes.
        if (DatabaseManager.isCorruptionError(err)) throw err;
        result.errors.push(`Error indexing ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  runBatch();
}

/**
 * Index one session file inside an already-open transaction. Uses a nested
 * SAVEPOINT so a DB error rolls back only this session's writes + metadata,
 * then propagates to runBulkIndexInTx's loop catch.
 */
function indexSessionFileInTx(db: DatabaseLike, dbManager: DatabaseManager, file: string, result: BulkIndexResult): void {
  result.sessionsProcessed++;

  const session = parseSessionFile(file);
  if (!session) {
    result.errors.push(`Failed to parse: ${file}`);
    return;
  }

  // db.transaction is guaranteed present here: the only caller
  // (runBulkIndexInTx) returns early via its `if (!db.transaction)` guard
  // before reaching this function. The guard also narrows the type so the
  // method call below type-checks. NB: must call db.transaction(...) as a
  // METHOD — better-sqlite3's implementation depends on `this`; detaching it
  // (const t = db.transaction) loses the binding and throws.
  if (!db.transaction) {
    throw new Error('indexSessionFileInTx requires transaction support');
  }
  const doSession = db.transaction((): { existed: boolean; messagesIndexed: number } => {
    const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id) as { id: string } | undefined;
    const before = (db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(session.id) as { count: number }).count;
    writeSessionToDb(db, session);
    upsertSessionFileMetadata(dbManager, file, session.id);
    const after = (db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(session.id) as { count: number }).count;
    return { existed: Boolean(existing), messagesIndexed: after - before };
  });

  // A throw here rolls back the SAVEPOINT (this session only) and propagates
  // to runBulkIndexInTx's loop, which logs it or escalates corruption.
  const outcome = doSession();

  if (outcome.existed && outcome.messagesIndexed === 0) {
    result.sessionsSkipped++;
  } else {
    result.sessionsIndexed++;
    result.messagesIndexed += outcome.messagesIndexed;
  }
}

/**
 * Cheaply count session JSONL files in the same scope indexAllSessions scans.
 */
export function countSessionFiles(sessionsDir: string): number {
  return getSessionFiles(sessionsDir).length;
}

function getLastBackfillTimestamp(dbManager: DatabaseManager): string | null {
  const db = dbManager.getDb();
  const row = db.prepare('SELECT value FROM extension_metadata WHERE key = ?').get(LAST_SESSION_BACKFILL_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

function isRecentBackfillTimestamp(value: string | null, nowMs: number): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  return nowMs - parsed < SESSION_BACKFILL_INTERVAL_MS;
}

/**
 * Determine whether a background session backfill should run.
 *
 * The check stays cheap: it compares file counts and stored file size/mtime
 * metadata. Full JSONL parsing is left to the scheduled incremental backfill.
 */
export function needsBackfill(dbManager: DatabaseManager, sessionsDir: string, now = new Date()): boolean {
  const db = dbManager.getDb();
  const files = getSessionFiles(sessionsDir);
  const indexed = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };

  if (files.length > indexed.count) {
    return true;
  }

  for (const file of files) {
    try {
      const metadata = getSessionFileMetadata(file);
      if (storedSessionFileMatches(dbManager, metadata)) continue;
      return true;
    } catch {
      return true;
    }
  }

  return !isRecentBackfillTimestamp(getLastBackfillTimestamp(dbManager), now.getTime());
}

/**
 * Record a successful session backfill completion timestamp.
 */
export function touchBackfillTimestamp(dbManager: DatabaseManager, timestamp = new Date()): void {
  const db = dbManager.getDb();
  db.prepare(`
    INSERT INTO extension_metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(LAST_SESSION_BACKFILL_KEY, timestamp.toISOString());
}

/**
 * Get statistics about indexed sessions.
 */
export function getSessionStats(dbManager: DatabaseManager): {
  totalSessions: number;
  totalMessages: number;
  projects: { project: string; sessions: number; messages: number }[];
} {
  const db = dbManager.getDb();

  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM sessions) as sessions,
      (SELECT COUNT(*) FROM messages) as messages
  `).get() as { sessions: number; messages: number };

  const projects = db.prepare(`
    SELECT
      s.project,
      COUNT(DISTINCT s.id) as sessions,
      COUNT(m.id) as messages
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    GROUP BY s.project
    ORDER BY sessions DESC
  `).all() as { project: string; sessions: number; messages: number }[];

  return {
    totalSessions: totals.sessions,
    totalMessages: totals.messages,
    projects,
  };
}
