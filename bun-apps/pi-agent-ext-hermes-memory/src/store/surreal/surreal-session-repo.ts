/**
 * SurrealSessionRepository — implements SessionRepository against a local
 * SurrealDB server. Mirrors SqliteSessionRepository semantics. Messages
 * carry denormalized `project` / `cwd` so searchSessions is a single-table
 * query (no JOIN needed). The FTS index message_fts (defined in schema.ts)
 * backs `content @@`.
 *
 * Live-server note (v3.2.3): `value` is a reserved keyword and CANNOT be
 * used in a `SELECT value ...` projection, nor can `type::record(...)` stand
 * in the FROM position of a SELECT. The backfill timestamp is therefore read
 * via `SELECT * FROM seq WHERE id = type::record("seq", $k)` and the `.value`
 * field is pulled from the whole row in TS.
 */

import fs from "node:fs";
import type { SurrealBackend } from "./surreal-backend.js";
import type {
  SessionRepository, SessionSearchResult, SessionStats,
  IndexResult, BulkIndexResult, IncrementalIndexOptions,
} from "../repository.js";
import { parseSessionFile, getSessionFiles } from "../session-parser.js";

const LAST_SESSION_BACKFILL_KEY = "last_session_backfill";
const SESSION_BACKFILL_INTERVAL_MS = 24 * 60 * 60 * 1000;

type SessionInput = {
  id: string; project?: string; cwd?: string; startedAt?: string;
  endedAt?: string | null;
  messages?: Array<{ id: string; role: "user" | "assistant" | "system"; content: string; timestamp: string; toolCalls?: string[] }>;
};

function emptyBulk(): BulkIndexResult {
  return { sessionsProcessed: 0, sessionsIndexed: 0, sessionsSkipped: 0, messagesIndexed: 0, errors: [] };
}

export class SurrealSessionRepository implements SessionRepository {
  constructor(private readonly backend: SurrealBackend) {}
  private get c() { return this.backend.client; }

  private async indexOne(sessionRaw: SessionInput): Promise<IndexResult> {
    const messages = sessionRaw.messages ?? [];
    const cwd = sessionRaw.cwd ?? "/unknown";
    const project = sessionRaw.project ??
      (sessionRaw.cwd ? (sessionRaw.cwd.split("/").pop() || sessionRaw.cwd) : "unknown");
    const startedAt = sessionRaw.startedAt ?? messages[0]?.timestamp ?? new Date().toISOString();
    const endedAt = sessionRaw.endedAt ?? null;

    // How many messages exist for this session already.
    const beforeRows = await this.c.query<Array<{ count: number }>>(
      `SELECT count() AS count FROM messages WHERE sessionId = $sid GROUP ALL;`, { sid: sessionRaw.id },
    );
    const before = beforeRows[0]?.count ?? 0;

    // Upsert the session row by its string record id (dedups on re-index).
    await this.c.query(
      `UPSERT type::record("sessions", $sid) SET sid = $sid, project = $project, cwd = $cwd, startedAt = $startedAt, endedAt = $endedAt, messageCount = $n;`,
      { sid: sessionRaw.id, project, cwd, startedAt, endedAt, n: messages.length },
    );

    for (const msg of messages) {
      await this.c.query(
        `UPSERT type::record("messages", $mid) SET sessionId = $sid, project = $project, cwd = $cwd, role = $role, content = $content, timestamp = $ts, toolCalls = $tc;`,
        { mid: msg.id, sid: sessionRaw.id, project, cwd, role: msg.role, content: msg.content, ts: msg.timestamp, tc: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null },
      );
    }

    const afterRows = await this.c.query<Array<{ count: number }>>(
      `SELECT count() AS count FROM messages WHERE sessionId = $sid GROUP ALL;`, { sid: sessionRaw.id },
    );
    const after = afterRows[0]?.count ?? 0;
    const messagesIndexed = after - before;
    return { sessionId: sessionRaw.id, messagesIndexed, skipped: before > 0 && messagesIndexed === 0 };
  }

  async indexSession(session: {
    id: string; project?: string; cwd?: string; startedAt?: string;
    endedAt?: string | null; messages?: unknown[];
  }): Promise<IndexResult> {
    return this.indexOne(session as SessionInput);
  }

  private async indexFile(file: string, result: BulkIndexResult): Promise<void> {
    result.sessionsProcessed++;
    const session = parseSessionFile(file);
    if (!session) { result.errors.push(`Failed to parse: ${file}`); return; }
    const existing = await this.c.query<unknown[]>(`SELECT sid FROM sessions WHERE sid = $sid LIMIT 1;`, { sid: session.id });
    const r = await this.indexOne(session);
    await this.upsertSessionFileMeta(file, session.id);
    if ((existing.length > 0) && r.messagesIndexed === 0) result.sessionsSkipped++;
    else { result.sessionsIndexed++; result.messagesIndexed += r.messagesIndexed; }
  }

  async indexAllSessions(sessionsDir: string, projectDir?: string): Promise<BulkIndexResult> {
    const files = getSessionFiles(sessionsDir, projectDir);
    const result = emptyBulk();
    for (const file of files) {
      try { await this.indexFile(file, result); }
      catch (err) { result.errors.push(`Error indexing ${file}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    return result;
  }

  async indexChangedSessions(sessionsDir: string, options: IncrementalIndexOptions = {}): Promise<BulkIndexResult> {
    const files = getSessionFiles(sessionsDir, options.projectDir);
    const maxFilesToIndex = options.maxFilesToIndex ?? 50;
    const result = emptyBulk();

    type Changed = { path: string; size: number; mtimeMs: number };
    const changed: Changed[] = [];
    for (const file of files) {
      try {
        const stat = fs.statSync(file);
        const meta = { path: file, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
        const stored = await this.c.query<Array<{ size: number; mtimeMs: number }>>(
          `SELECT size, mtimeMs FROM session_files WHERE path = $path LIMIT 1;`, { path: file },
        );
        if (stored.length > 0 && stored[0].size === meta.size && stored[0].mtimeMs === meta.mtimeMs) {
          result.sessionsSkipped++;
          continue;
        }
        changed.push(meta);
      } catch (err) { result.errors.push(`Error indexing ${file}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    changed.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const toIndex: string[] = [];
    for (const m of changed) {
      if (toIndex.length >= maxFilesToIndex) { result.reachedLimit = true; break; }
      toIndex.push(m.path);
    }
    for (const file of toIndex) {
      try { await this.indexFile(file, result); }
      catch (err) { result.errors.push(`Error indexing ${file}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    return result;
  }

  async upsertSessionFileMeta(filePath: string, sessionId: string, options?: { size?: number; mtimeMs?: number }): Promise<void> {
    const stat = options && (options.size !== undefined || options.mtimeMs !== undefined)
      ? { size: options.size ?? fs.statSync(filePath).size, mtimeMs: options.mtimeMs ?? Math.trunc(fs.statSync(filePath).mtimeMs) }
      : { size: fs.statSync(filePath).size, mtimeMs: Math.trunc(fs.statSync(filePath).mtimeMs) };
    await this.c.query(
      `DELETE FROM session_files WHERE path = $path; CREATE session_files SET path = $path, sessionId = $sid, size = $size, mtimeMs = $mtimeMs, indexedAt = $idx;`,
      { path: filePath, sid: sessionId, size: stat.size, mtimeMs: stat.mtimeMs, idx: new Date().toISOString() },
    );
  }

  async needsBackfill(sessionsDir: string, now?: number): Promise<boolean> {
    const files = getSessionFiles(sessionsDir);
    const indexed = await this.c.query<Array<{ count: number }>>(`SELECT count() AS count FROM sessions GROUP ALL;`);
    if (files.length > (indexed[0]?.count ?? 0)) return true;
    for (const file of files) {
      try {
        const stat = fs.statSync(file);
        const stored = await this.c.query<Array<{ size: number; mtimeMs: number }>>(`SELECT size, mtimeMs FROM session_files WHERE path = $path LIMIT 1;`, { path: file });
        if (!(stored.length > 0 && stored[0].size === stat.size && stored[0].mtimeMs === Math.trunc(stat.mtimeMs))) return true;
      } catch { return true; }
    }
    // Backfill timestamp stored on a dedicated seq:<key> record. v3.2.3:
    // `value` is reserved and `type::record(...)` is not allowed in SELECT's
    // FROM position, so we filter the whole seq table by record id and read
    // `.value` from the row in TS.
    const row = await this.c.query<Array<{ value: string }>>(`SELECT * FROM seq WHERE id = type::record("seq", $k) LIMIT 1;`, { k: LAST_SESSION_BACKFILL_KEY });
    const value = row[0]?.value ?? null;
    if (!value) return true;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return true;
    const nowMs = now !== undefined ? now : Date.now();
    return nowMs - parsed >= SESSION_BACKFILL_INTERVAL_MS;
  }

  async touchBackfillTimestamp(timestamp?: string): Promise<void> {
    const ts = timestamp ?? new Date().toISOString();
    await this.c.query(`UPSERT type::record("seq", $k) SET value = $v;`, { k: LAST_SESSION_BACKFILL_KEY, v: ts });
  }

  async searchSessions(query: string, options: { project?: string | null; role?: "user" | "assistant" | "system"; limit?: number } = {}): Promise<SessionSearchResult[]> {
    if (query.trim().length === 0) return [];
    const { limit = 10, project, role } = options;
    const conds = ["content @@ $q"];
    const params: Record<string, unknown> = { q: query };
    if (project !== undefined && project !== null) { conds.push("project = $project"); params.project = project; }
    if (role) { conds.push("role = $role"); params.role = role; }
    const rows = await this.c.query<Array<{ id: string; sessionId: string; project: string; cwd: string; role: string; content: string; timestamp: string }>>(
      `SELECT id, sessionId, project, cwd, role, content, timestamp FROM messages WHERE ${conds.join(" AND ")} ORDER BY timestamp DESC LIMIT ${Number(limit)};`,
      params,
    );
    return rows.map((r) => ({
      sessionId: r.sessionId, messageId: r.id, role: r.role as "user" | "assistant" | "system",
      content: r.content, timestamp: r.timestamp, project: r.project, cwd: r.cwd,
    }));
  }

  async getIndexedMessageCount(): Promise<number> {
    const rows = await this.c.query<Array<{ count: number }>>(`SELECT count() AS count FROM messages GROUP ALL;`);
    return rows[0]?.count ?? 0;
  }

  async getSessionStats(): Promise<SessionStats> {
    const sess = await this.c.query<Array<{ count: number }>>(`SELECT count() AS count FROM sessions GROUP ALL;`);
    const msg = await this.c.query<Array<{ count: number }>>(`SELECT count() AS count FROM messages GROUP ALL;`);
    const projects = await this.c.query<Array<{ project: string | null; sessions: number }>>(
      `SELECT project, count() AS sessions FROM sessions GROUP BY project;`,
    );
    return {
      totalSessions: sess[0]?.count ?? 0,
      totalMessages: msg[0]?.count ?? 0,
      projects: projects.map((p) => ({ project: p.project ?? "", sessions: p.sessions ?? 0, messages: 0 })),
    };
  }
}
