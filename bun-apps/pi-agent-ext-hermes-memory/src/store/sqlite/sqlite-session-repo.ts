/**
 * SqliteSessionRepository — async, backend-neutral(ish) repository wrapping the
 * SQLite session store. Ports the free functions of `session-indexer.ts` and
 * `session-search.ts` into a class that implements `SessionRepository`.
 *
 * Every public method wraps its body in
 *   `runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => { ... }))`
 * absorbing the corruption-recovery + transient-retry wrappers that today live
 * at call sites. `withCorruptionRecovery` is synchronous, so it MUST sit INSIDE
 * `runWithTransientRetry` — otherwise its sync try/catch sees a Promise and a
 * later async corruption rejection bypasses the rebuild. The SQL bodies are
 * copied verbatim from the original free
 * functions (same SQL, same params, same logic); the SQLite driver calls are
 * sync, so we just `return` their result from the async method.
 *
 * This file does NOT import the SQLite driver directly — it goes through
 * `SqliteBackend.getDb()`. The old `session-indexer.ts` + `session-search.ts`
 * stay intact until Task 8 sweeps the handler call sites; all three coexist.
 *
 * NB on the `indexSession` input shape: the interface types the param loosely
 * (`{ id; project?; cwd?; startedAt?; messages? }`) but the real parsed Pi
 * session object (from `parseSessionFile` / live-index callers) carries the
 * SAME camelCase fields the original `indexSession` reads (`endedAt`, typed
 * messages with `toolCalls`). We cast to an internal structural type to reach
 * those fields verbatim and preserve today's behavior exactly. The handler
 * (Task 8) passes the parsed session through unchanged.
 */

import fs from "node:fs";
import { SqliteBackend, type DatabaseLike } from "./sqlite-backend.js";
import { runWithTransientRetry } from "./sqlite-backend.js";
import type {
  SessionRepository,
  SessionSearchResult,
  SessionStats,
  IndexResult,
  BulkIndexResult,
  IncrementalIndexOptions,
} from "../repository.js";
import { parseSessionFile, getSessionFiles } from "../session-parser.js";
import {
  buildFallbackFts5Query,
  hasExplicitFts5Operator,
  isFts5QueryError,
  normalizeFts5Query,
} from "./fts-query.js";

// ---------------------------------------------------------------------------
// Constants (copied verbatim from session-indexer.ts).
// ---------------------------------------------------------------------------

const LAST_SESSION_BACKFILL_KEY = "last_session_backfill";
const SESSION_BACKFILL_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Internal types.
// ---------------------------------------------------------------------------

/**
 * The real shape the original `indexSession` reads off its `session` argument.
 * The interface types the param loosely, but the live caller (parseSessionFile
 * / parseSessionManagerSnapshot) always supplies these fields. We cast to this
 * type internally so today's field access is preserved byte-identical.
 */
type SessionInput = {
  id: string;
  project?: string;
  cwd?: string;
  startedAt?: string;
  endedAt?: string | null;
  messages?: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    timestamp: string;
    toolCalls?: string[];
  }>;
};

/** Mirror of the original SessionFileMetadata (internal helper). */
interface SessionFileMetadata {
  path: string;
  size: number;
  mtimeMs: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (copied verbatim from session-search.ts).
// ---------------------------------------------------------------------------

const QUERY_TOKEN_PATTERN = /"([^"]*)"|(\S+)/g;
const NATURAL_LANGUAGE_CONNECTORS = new Set(["and", "or", "not", "near"]);

function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

function collectLikeTerms(query: string): string[] {
  const terms: string[] = [];

  for (const match of query.matchAll(QUERY_TOKEN_PATTERN)) {
    const phrase = match[1];
    const term = match[2];
    if (phrase === undefined && term && NATURAL_LANGUAGE_CONNECTORS.has(term.toLowerCase())) {
      continue;
    }

    const rawValue = phrase ?? term ?? "";
    if (rawValue.length > 0) terms.push(rawValue);
  }

  return terms;
}

// ---------------------------------------------------------------------------
// Repository.
// ---------------------------------------------------------------------------

export class SqliteSessionRepository implements SessionRepository {
  constructor(private readonly backend: SqliteBackend) {}

  private get db(): DatabaseLike {
    return this.backend.getDb();
  }

  // -------------------------------------------------------------------------
  // indexSession — from indexSession + indexSessionOnce + writeSessionToDb.
  // -------------------------------------------------------------------------

  /**
   * Write one session's rows (session upsert + message inserts + count sync).
   * Transaction-free: callers manage transaction boundaries. Extracted so the
   * bulk indexing path can batch many sessions into a SINGLE transaction
   * (10-50× fewer fsyncs than one transaction per session).
   */
  private writeSessionToDb(db: DatabaseLike, session: SessionInput): void {
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

    const messages = session.messages ?? [];

    insertSession.run(
      session.id,
      session.project,
      session.cwd,
      session.startedAt,
      session.endedAt,
      messages.length,
    );

    for (const msg of messages) {
      insertMsg.run(
        msg.id,
        session.id,
        msg.role,
        msg.content,
        msg.timestamp,
        msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
      );
    }

    updateSession.run(session.project, session.cwd, session.endedAt, session.id, session.id);
  }

  /** Unwrapped core (the original indexSessionOnce). */
  private indexSessionOnce(sessionRaw: SessionInput): IndexResult {
    const db = this.backend.getDb();

    // The interface types cwd/project/startedAt as optional, but the sessions
    // schema enforces NOT NULL on all three. Every real caller (parseSessionFile
    // / parseSessionManagerSnapshot) supplies them; for the optional-interface
    // path we fill gaps with the same derivation the recovery path in
    // SqliteBackend.copySessions + parseSessionFile uses, so a session indexed
    // through the interface never trips NOT NULL. The real fields are still
    // read off the incoming object exactly as the original did.
    const messages = sessionRaw.messages ?? [];
    const session: SessionInput = {
      ...sessionRaw,
      cwd: sessionRaw.cwd ?? "/unknown",
      project:
        sessionRaw.project ??
        (sessionRaw.cwd ? sessionRaw.cwd.split("/").pop() || sessionRaw.cwd : "unknown"),
      startedAt: sessionRaw.startedAt ?? messages[0]?.timestamp ?? new Date().toISOString(),
      endedAt: sessionRaw.endedAt ?? null,
    };

    const existingSession = db.prepare("SELECT id FROM sessions WHERE id = ?").get(session.id) as
      | { id: string }
      | undefined;
    const before = db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").get(session.id) as {
      count: number;
    };

    const write = () => this.writeSessionToDb(db, session);

    if (db.transaction) {
      const tx = db.transaction(write);
      tx();
    } else {
      write();
    }

    const after = db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").get(session.id) as {
      count: number;
    };
    const messagesIndexed = after.count - before.count;

    return {
      sessionId: session.id,
      messagesIndexed,
      skipped: Boolean(existingSession) && messagesIndexed === 0,
    };
  }

  async indexSession(session: {
    id: string;
    project?: string;
    cwd?: string;
    startedAt?: string;
    endedAt?: string | null;
    messages?: unknown[];
  }): Promise<IndexResult> {
    return runWithTransientRetry(() =>
      this.backend.withCorruptionRecovery(() => this.indexSessionOnce(session as SessionInput)),
    );
  }

  // -------------------------------------------------------------------------
  // Bulk indexing internals — from runBulkIndexInTx + indexSessionFile(InTx).
  // -------------------------------------------------------------------------

  private getSessionFileMetadata(filePath: string): SessionFileMetadata {
    const stat = fs.statSync(filePath);
    return { path: filePath, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
  }

  private getStoredSessionFileMetadata(
    filePath: string,
  ): { size: number; mtime_ms: number } | undefined {
    return this.db.prepare("SELECT size, mtime_ms FROM session_files WHERE path = ?").get(filePath) as
      | { size: number; mtime_ms: number }
      | undefined;
  }

  private storedSessionFileMatches(metadata: SessionFileMetadata): boolean {
    const row = this.getStoredSessionFileMetadata(metadata.path);
    return Boolean(row && row.size === metadata.size && row.mtime_ms === metadata.mtimeMs);
  }

  /** Unwrapped core of upsertSessionFileMetadata (original signature). */
  private upsertSessionFileMetaInternal(
    filePath: string,
    sessionId: string,
    metadata: SessionFileMetadata = this.getSessionFileMetadata(filePath),
    indexedAt: Date = new Date(),
  ): void {
    this.db.prepare(`
      INSERT INTO session_files (path, session_id, size, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        session_id = excluded.session_id,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        indexed_at = excluded.indexed_at
    `).run(metadata.path, sessionId, metadata.size, metadata.mtimeMs, indexedAt.toISOString());
  }

  private emptyBulkIndexResult(): BulkIndexResult {
    return {
      sessionsProcessed: 0,
      sessionsIndexed: 0,
      sessionsSkipped: 0,
      messagesIndexed: 0,
      errors: [],
    };
  }

  /** Per-session indexing used by the legacy no-transaction fallback path. */
  private indexSessionFile(file: string, result: BulkIndexResult): void {
    result.sessionsProcessed++;

    const session = parseSessionFile(file);
    if (!session) {
      result.errors.push(`Failed to parse: ${file}`);
      return;
    }

    // Mirrors indexSessionOnce but returns IndexResult-equivalent accounting.
    const db = this.backend.getDb();
    const existing = db.prepare("SELECT id FROM sessions WHERE id = ?").get(session.id) as
      | { id: string }
      | undefined;
    const before = (db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").get(session.id) as { count: number }).count;
    const write = () => this.writeSessionToDb(db, session);
    if (db.transaction) {
      db.transaction(write)();
    } else {
      write();
    }
    this.upsertSessionFileMetaInternal(file, session.id);
    const after = (db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").get(session.id) as { count: number }).count;
    const messagesIndexed = after - before;
    const skipped = Boolean(existing) && messagesIndexed === 0;

    if (skipped) {
      result.sessionsSkipped++;
    } else {
      result.sessionsIndexed++;
      result.messagesIndexed += messagesIndexed;
    }
  }

  /**
   * Index one session file inside an already-open transaction. Uses a nested
   * SAVEPOINT so a DB error rolls back only this session's writes + metadata,
   * then propagates to runBulkIndexInTx's loop catch.
   */
  private indexSessionFileInTx(db: DatabaseLike, file: string, result: BulkIndexResult): void {
    result.sessionsProcessed++;

    const session = parseSessionFile(file);
    if (!session) {
      result.errors.push(`Failed to parse: ${file}`);
      return;
    }

    // db.transaction is guaranteed present here: the only caller
    // (runBulkIndexInTx) returns early via its `if (!db.transaction)` guard
    // before reaching this function. NB: must call db.transaction(...) as a
    // METHOD — better-sqlite3's implementation depends on `this`; detaching it
    // (const t = db.transaction) loses the binding and throws.
    if (!db.transaction) {
      throw new Error("indexSessionFileInTx requires transaction support");
    }
    const doSession = db.transaction((): { existed: boolean; messagesIndexed: number } => {
      const existing = db.prepare("SELECT id FROM sessions WHERE id = ?").get(session.id) as
        | { id: string }
        | undefined;
      const before = (db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").get(session.id) as { count: number }).count;
      this.writeSessionToDb(db, session);
      this.upsertSessionFileMetaInternal(file, session.id);
      const after = (db.prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?").get(session.id) as { count: number }).count;
      return { existed: Boolean(existing), messagesIndexed: after - before };
    });

    const outcome = doSession();

    if (outcome.existed && outcome.messagesIndexed === 0) {
      result.sessionsSkipped++;
    } else {
      result.sessionsIndexed++;
      result.messagesIndexed += outcome.messagesIndexed;
    }
  }

  /**
   * Bulk-index `files` inside a SINGLE outer transaction with per-session
   * SAVEPOINT isolation. (Copied verbatim from session-indexer.ts.)
   */
  private runBulkIndexInTx(files: string[], result: BulkIndexResult): void {
    const db = this.backend.getDb();

    if (!db.transaction) {
      for (const file of files) {
        try {
          this.indexSessionFile(file, result);
        } catch (err) {
          result.errors.push(`Error indexing ${file}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }

    const runBatch = db.transaction(() => {
      for (const file of files) {
        try {
          this.indexSessionFileInTx(db, file, result);
        } catch (err) {
          if (SqliteBackend.isCorruptionError(err)) throw err;
          result.errors.push(`Error indexing ${file}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    runBatch();
  }

  // -------------------------------------------------------------------------
  // indexAllSessions — from indexAllSessions.
  // -------------------------------------------------------------------------

  async indexAllSessions(
    sessionsDir: string,
    projectDir?: string,
  ): Promise<BulkIndexResult> {
    return runWithTransientRetry(() =>
      this.backend.withCorruptionRecovery(() => {
        const files = getSessionFiles(sessionsDir, projectDir);
        const result = this.emptyBulkIndexResult();

        // ONE transaction for the whole batch. Each session is isolated by a
        // nested SAVEPOINT (see runBulkIndexInTx), so a single bad session
        // rolls back only itself — but all surviving sessions commit together
        // in a single fsync.
        this.runBulkIndexInTx(files, result);

        return result;
      }),
    );
  }

  // -------------------------------------------------------------------------
  // indexChangedSessions — from indexChangedSessions.
  // -------------------------------------------------------------------------

  async indexChangedSessions(
    sessionsDir: string,
    options: IncrementalIndexOptions = {},
  ): Promise<BulkIndexResult> {
    return runWithTransientRetry(() =>
      this.backend.withCorruptionRecovery(() => {
        const files = getSessionFiles(sessionsDir, options.projectDir);
        const maxFilesToIndex = options.maxFilesToIndex ?? 50;
        const result = this.emptyBulkIndexResult();

        // Gather the changed set first, then sort newest-first before applying
        // the cap. Crash recovery is the primary value of startup backfill.
        const changed: SessionFileMetadata[] = [];
        for (const file of files) {
          try {
            const metadata = this.getSessionFileMetadata(file);
            if (this.storedSessionFileMatches(metadata)) {
              result.sessionsSkipped++;
              continue;
            }
            changed.push(metadata);
          } catch (err) {
            result.errors.push(`Error indexing ${file}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        changed.sort((a, b) => b.mtimeMs - a.mtimeMs);

        const toIndex: string[] = [];
        for (const metadata of changed) {
          if (toIndex.length >= maxFilesToIndex) {
            result.reachedLimit = true;
            break;
          }
          toIndex.push(metadata.path);
        }

        this.runBulkIndexInTx(toIndex, result);

        return result;
      }),
    );
  }

  // -------------------------------------------------------------------------
  // upsertSessionFileMeta — from upsertSessionFileMetadata.
  // -------------------------------------------------------------------------

  async upsertSessionFileMeta(
    filePath: string,
    sessionId: string,
    options?: { size?: number; mtimeMs?: number },
  ): Promise<void> {
    return runWithTransientRetry(() =>
      this.backend.withCorruptionRecovery(() => {
        const metadata: SessionFileMetadata =
          options && (options.size !== undefined || options.mtimeMs !== undefined)
            ? {
                path: filePath,
                size: options.size ?? this.getSessionFileMetadata(filePath).size,
                mtimeMs: options.mtimeMs ?? this.getSessionFileMetadata(filePath).mtimeMs,
              }
            : this.getSessionFileMetadata(filePath);
        this.upsertSessionFileMetaInternal(filePath, sessionId, metadata);
      }),
    );
  }

  // -------------------------------------------------------------------------
  // needsBackfill — from needsBackfill.
  // -------------------------------------------------------------------------

  private getLastBackfillTimestamp(): string | null {
    const row = this.db.prepare("SELECT value FROM extension_metadata WHERE key = ?").get(
      LAST_SESSION_BACKFILL_KEY,
    ) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private isRecentBackfillTimestamp(value: string | null, nowMs: number): boolean {
    if (!value) return false;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return false;
    return nowMs - parsed < SESSION_BACKFILL_INTERVAL_MS;
  }

  async needsBackfill(sessionsDir: string, now?: number): Promise<boolean> {
    return runWithTransientRetry(() =>
      this.backend.withCorruptionRecovery(() => {
        const nowDate = now !== undefined ? new Date(now) : new Date();
        const files = getSessionFiles(sessionsDir);
        const indexed = this.db.prepare("SELECT COUNT(*) as count FROM sessions").get() as { count: number };

        if (files.length > indexed.count) {
          return true;
        }

        for (const file of files) {
          try {
            const metadata = this.getSessionFileMetadata(file);
            if (this.storedSessionFileMatches(metadata)) continue;
            return true;
          } catch {
            return true;
          }
        }

        return !this.isRecentBackfillTimestamp(this.getLastBackfillTimestamp(), nowDate.getTime());
      }),
    );
  }

  // -------------------------------------------------------------------------
  // touchBackfillTimestamp — from touchBackfillTimestamp.
  // -------------------------------------------------------------------------

  async touchBackfillTimestamp(timestamp?: string): Promise<void> {
    return runWithTransientRetry(() =>
      this.backend.withCorruptionRecovery(() => {
        const ts = timestamp ? new Date(timestamp) : new Date();
        this.db.prepare(`
          INSERT INTO extension_metadata (key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(LAST_SESSION_BACKFILL_KEY, ts.toISOString());
      }),
    );
  }

  // -------------------------------------------------------------------------
  // searchSessions — from searchSessions.
  // -------------------------------------------------------------------------

  async searchSessions(
    query: string,
    options: { project?: string | null; role?: "user" | "assistant" | "system"; limit?: number } = {},
  ): Promise<SessionSearchResult[]> {
    return runWithTransientRetry(() =>
      this.backend.withCorruptionRecovery(() => {
        if (query.trim().length === 0) {
          return [];
        }

        const db = this.backend.getDb();
        const { limit = 10, project, role } = options;

        type SearchMatch =
          | { type: "fts"; query: string }
          | { type: "like"; terms: string[] };

        const executeSearch = (match: SearchMatch): SessionSearchResult[] => {
          const conditions: string[] = [];
          const params: unknown[] = [];

          if (match.type === "fts") {
            conditions.push("m.rowid IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ?)");
            params.push(match.query);
          } else {
            if (match.terms.length === 0) {
              return [];
            }
            const likeConditions = match.terms.map(() => `m.content LIKE ? ESCAPE '\\'`);
            conditions.push(`(${likeConditions.join(" OR ")})`);
            for (const term of match.terms) {
              params.push(`%${escapeLikePattern(term)}%`);
            }
          }

          if (project !== undefined && project !== null) {
            conditions.push("s.project = ?");
            params.push(project);
          }

          if (role) {
            conditions.push("m.role = ?");
            params.push(role);
          }

          const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

          // SELECT widened vs the original to populate the DTO's `messageId`
          // and `cwd` fields. The original selected `m.content as snippet`
          // (a duplicate of `m.content`); the DTO has no `snippet` column, so
          // it is dropped here with no data loss (content already carries it).
          const sql = `
            SELECT
              m.session_id,
              m.id AS message_id,
              s.project,
              s.cwd,
              m.role,
              m.content,
              m.timestamp
            FROM messages m
            JOIN sessions s ON s.id = m.session_id
            ${whereClause}
            ORDER BY m.timestamp DESC
            LIMIT ?
          `;

          try {
            const rows = db.prepare(sql).all(...params, limit) as Array<{
              session_id: string;
              message_id: string;
              project: string;
              cwd: string;
              role: string;
              content: string;
              timestamp: string;
            }>;

            return rows.map((row) => ({
              sessionId: row.session_id,
              messageId: row.message_id,
              role: row.role as "user" | "assistant" | "system",
              content: row.content,
              timestamp: row.timestamp,
              project: row.project,
              cwd: row.cwd,
            }));
          } catch (err) {
            if (match.type === "fts" && isFts5QueryError(err)) {
              return [];
            }
            throw err;
          }
        };

        const normalizedQuery = normalizeFts5Query(query);
        if (normalizedQuery.length === 0) {
          return [];
        }

        const exactResults = executeSearch({ type: "fts", query: normalizedQuery });
        if (exactResults.length > 0) {
          return exactResults;
        }

        const explicitOperatorQuery = hasExplicitFts5Operator(query);
        if (explicitOperatorQuery) {
          return exactResults;
        }

        const fallbackQuery = buildFallbackFts5Query(query);
        if (fallbackQuery && fallbackQuery !== normalizedQuery) {
          const fallbackResults = executeSearch({ type: "fts", query: fallbackQuery });
          if (fallbackResults.length > 0) {
            return fallbackResults;
          }
        }

        const likeTerms = collectLikeTerms(query);
        return executeSearch({ type: "like", terms: likeTerms });
      }),
    );
  }

  // -------------------------------------------------------------------------
  // getIndexedMessageCount — from getIndexedMessageCount.
  // -------------------------------------------------------------------------

  async getIndexedMessageCount(): Promise<number> {
    return runWithTransientRetry(() =>
      this.backend.withCorruptionRecovery(() => {
        const result = this.db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };
        return result.count;
      }),
    );
  }

  // -------------------------------------------------------------------------
  // recordAssembly — FK-free prompt-provenance (UPSP §5).
  // ------------------------------------------------------------------------

  /**
   * Write one session's assembly rows (meta upsert + assembly set replace).
   * Transaction-free: callers manage transaction boundaries (mirrors
   * `writeSessionToDb`). FK-free: NEVER touches the `sessions` table — the
   * sessions row is created later by deferred backfill, so `session_id` is a
   * plain join key here, not a foreign key.
   */
  private writeAssemblyToDb(
    db: DatabaseLike,
    sessionId: string,
    mdIds: readonly string[],
    hash: string,
  ): void {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO session_assembly_meta (session_id, hash, captured_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(session_id) DO UPDATE SET hash = excluded.hash, captured_at = excluded.captured_at",
    ).run(sessionId, hash, now);
    db.prepare("DELETE FROM session_assembly WHERE session_id = ?").run(sessionId);
    const ins = db.prepare(
      "INSERT OR IGNORE INTO session_assembly (session_id, md_id) VALUES (?, ?)",
    );
    for (const id of mdIds) ins.run(sessionId, id);
  }

  async recordAssembly(
    sessionId: string,
    mdIds: readonly string[],
    hash: string,
  ): Promise<void> {
    await runWithTransientRetry(() =>
      this.backend.withCorruptionRecovery(() => {
        const db = this.backend.getDb();
        const write = () => this.writeAssemblyToDb(db, sessionId, mdIds, hash);
        // `transaction` is optional on DatabaseLike (in-memory/test backends may
        // omit it); mirror the indexSessionOnce guard so the assembly set still
        // lands atomically when a real driver is present.
        if (db.transaction) {
          db.transaction(write)();
        } else {
          write();
        }
      }),
    );
  }

  // -------------------------------------------------------------------------
  // markUsed — UPSP §9 "used vs dropped" signal (stamp used_at on referenced rows).
  // ------------------------------------------------------------------------

  /**
   * UPDATE in place: stamp `usedAt` on the surfaced `(sessionId, mdId)` rows
   * the agent's output actually referenced. Sets ONLY matched rows for that
   * session; non-matched rows stay null. Idempotent (a re-mark re-stamps).
   * Empty `mdIds` is a no-op (skips the query). NEVER touches
   * `session_assembly_meta` or any other table. Mirrors `recordAssembly`'s
   * transient-retry + corruption-recovery safety envelope.
   */
  async markUsed(
    sessionId: string,
    mdIds: readonly string[],
    usedAt: string,
  ): Promise<void> {
    await runWithTransientRetry(() =>
      this.backend.withCorruptionRecovery(() => {
        if (mdIds.length === 0) return;
        const db = this.backend.getDb();
        // Dynamic `?` placeholders — never string-interpolate ids (injection-safe;
        // matches the searchSessions binding style). matched-rows-only by the
        // WHERE (session_id AND md_id IN …) filter; other tables untouched.
        const placeholders = mdIds.map(() => "?").join(", ");
        const sql = `UPDATE session_assembly SET used_at = ? WHERE session_id = ? AND md_id IN (${placeholders})`;
        db.prepare(sql).run(usedAt, sessionId, ...mdIds);
      }),
    );
  }

  // -------------------------------------------------------------------------
  // getUsedMdIds — UPSP §1/D4 boolean ever-used aggregate (Task 2 of #1b decay).
  // ------------------------------------------------------------------------

  /**
   * SELECT the distinct md_ids (out of the input set) that have ≥1
   * `session_assembly` row with `used_at IS NOT NULL`. The boolean ever-used
   * signal (#06) consumed by Task 3's heat-provider. One batched query; empty
   * input → empty Set (no-op, no SQL). The `session_assembly` table is GLOBAL
   * (no `project` column) — `opts.project` is accepted but ignored (see the
   * interface JSDoc). Mirrors `markUsed`'s single-placeholder-list `IN` pattern
   * (no chunking helper exists; the assembled set is bounded by the memory
   * block size, well under SQLite's variable limit) and its transient-retry +
   * corruption-recovery envelope. NEVER touches `session_assembly_meta` or any
   * other table.
   */
  async getUsedMdIds(
    mdIds: string[],
    _opts: { project: string | null },
  ): Promise<Set<string>> {
    return runWithTransientRetry(() =>
      this.backend.withCorruptionRecovery(() => {
        if (mdIds.length === 0) return new Set<string>();
        const db = this.backend.getDb();
        // Dynamic `?` placeholders — injection-safe (matches markUsed/searchSessions).
        // DISTINCT collapses the (session_id, md_id) PK so a md_id used across many
        // sessions is reported once. `used_at IS NOT NULL` filters surfaced-unused.
        const placeholders = mdIds.map(() => "?").join(", ");
        const sql = `SELECT DISTINCT md_id FROM session_assembly WHERE used_at IS NOT NULL AND md_id IN (${placeholders})`;
        const rows = db.prepare(sql).all(...mdIds) as Array<{ md_id: string }>;
        return new Set(rows.map((r) => r.md_id));
      }),
    );
  }

  // -------------------------------------------------------------------------
  // getSessionStats — from getSessionStats.
  // -------------------------------------------------------------------------

  async getSessionStats(): Promise<SessionStats> {
    return runWithTransientRetry(() =>
      this.backend.withCorruptionRecovery(() => {
        const totals = this.db.prepare(`
          SELECT
            (SELECT COUNT(*) FROM sessions) as sessions,
            (SELECT COUNT(*) FROM messages) as messages
        `).get() as { sessions: number; messages: number };

        const projects = this.db.prepare(`
          SELECT
            s.project,
            COUNT(DISTINCT s.id) as sessions,
            COUNT(m.id) as messages
          FROM sessions s
          LEFT JOIN messages m ON m.session_id = s.id
          GROUP BY s.project
          ORDER BY sessions DESC
        `).all() as { project: string | null; sessions: number; messages: number }[];

        return {
          totalSessions: totals.sessions,
          totalMessages: totals.messages,
          // SQLite GROUP BY can yield null for project on edge-case rows;
          // coerce to empty string to match the SessionStats DTO (string).
          projects: projects.map((p) => ({ ...p, project: p.project ?? "" })),
        };
      }),
    );
  }
}
