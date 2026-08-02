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

/** Max message UPSERTs concatenated into a single /sql body. Bounds request
 * size while collapsing the old N+1 HTTP round-trips down to ceil(N/this). */
const MESSAGE_BATCH_SIZE = 200;

export class SurrealSessionRepository implements SessionRepository {
  constructor(private readonly backend: SurrealBackend) {}
  private get c() { return this.backend.client; }

  /** Fetch ALL session_files meta in ONE round-trip and return a path →
   *  {size, mtimeMs} map for in-TS diffing. Replaces the per-file
   *  `SELECT ... WHERE path = $path` N+1 that, on the real 3515-file sessions
   *  dir, made needsBackfill alone cost ~11s/1107 round-trips at session_start. */
  private async fetchSessionFileMeta(): Promise<Map<string, { size: number; mtimeMs: number }>> {
    const rows = await this.c.query<Array<{ path: string; size: number; mtimeMs: number }>>(
      `SELECT path, size, mtimeMs FROM session_files;`,
    );
    const map = new Map<string, { size: number; mtimeMs: number }>();
    for (const r of rows) map.set(r.path, { size: r.size, mtimeMs: r.mtimeMs });
    return map;
  }

  private async indexOne(sessionRaw: SessionInput): Promise<IndexResult> {
    const messages = sessionRaw.messages ?? [];
    const cwd = sessionRaw.cwd ?? "/unknown";
    const project = sessionRaw.project ??
      (sessionRaw.cwd ? (sessionRaw.cwd.split("/").pop() || sessionRaw.cwd) : "unknown");
    const startedAt = sessionRaw.startedAt ?? messages[0]?.timestamp ?? new Date().toISOString();
    const endedAt = sessionRaw.endedAt ?? null;

    // Incremental: fetch the message ids already indexed for this session and
    // UPSERT only the MISSING ones. A caught-up re-index (delta=0) skips the
    // batched UPSERT loop entirely — previously it re-UPSERTed EVERY message on
    // every indexSession (shutdown + every message_end live-index), ~400ms of
    // pure waste on a 1348-msg session despite writing nothing new.
    // `record::id(id)` returns the plain message id (the string passed to
    // `type::record("messages", $mid)` at insert time), directly comparable to
    // `m.id` with no record-id escaping to reverse.
    const existing = await this.c.query<Array<{ mid: string }>>(
      `SELECT record::id(id) AS mid FROM messages WHERE sessionId = $sid;`, { sid: sessionRaw.id },
    );
    const existingIds = new Set(existing.map((r) => String(r.mid)));
    const before = existing.length;
    const delta = messages.filter((m) => !existingIds.has(m.id));

    // Upsert the session row by its string record id (keeps messageCount /
    // endedAt fresh even when no messages are new).
    await this.c.query(
      `UPSERT type::record("sessions", $sid) SET sid = $sid, project = $project, cwd = $cwd, startedAt = $startedAt, endedAt = $endedAt, messageCount = $n;`,
      { sid: sessionRaw.id, project, cwd, startedAt, endedAt, n: messages.length },
    );

    // Batch ONLY the new messages into chunked multi-statement /sql bodies.
    // #894 collapsed the original N+1 HTTP round-trips (one per message) to
    // ceil(N/SIZE) by concatenating UPSERTs; this change further collapses the
    // input from N (all messages) to |delta| (only new), so a caught-up re-index
    // makes ZERO message round-trips and a small delta makes one. SurrealClient
    // .query validates every statement in a batch and throws on any per-
    // statement error, so we concatenate up to MESSAGE_BATCH_SIZE UPSERTs per
    // body with indexed params ($m0_mid, $m1_mid, ...).
    const batches = Math.ceil(delta.length / MESSAGE_BATCH_SIZE);
    for (let b = 0; b < batches; b++) {
      const slice = delta.slice(b * MESSAGE_BATCH_SIZE, (b + 1) * MESSAGE_BATCH_SIZE);
      const stmts: string[] = [];
      const params: Record<string, unknown> = { sid: sessionRaw.id, project, cwd };
      for (let i = 0; i < slice.length; i++) {
        const m = slice[i];
        const p = `m${b * MESSAGE_BATCH_SIZE + i}`;
        params[`${p}_mid`] = m.id;
        params[`${p}_role`] = m.role;
        params[`${p}_content`] = m.content;
        params[`${p}_ts`] = m.timestamp;
        params[`${p}_tc`] = m.toolCalls ? JSON.stringify(m.toolCalls) : null;
        stmts.push(
          `UPSERT type::record("messages", $${p}_mid) SET sessionId = $sid, project = $project, cwd = $cwd, role = $${p}_role, content = $${p}_content, timestamp = $${p}_ts, toolCalls = $${p}_tc;`,
        );
      }
      await this.c.query(stmts.join("\n"), params);
    }

    const messagesIndexed = delta.length;
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
    // BATCHED: fetch all session_files meta in one round-trip and diff in TS.
    // Previously a per-file HTTP round-trip per session file (N+1).
    const metaByPath = await this.fetchSessionFileMeta();
    for (const file of files) {
      try {
        const stat = fs.statSync(file);
        const meta = { path: file, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
        const stored = metaByPath.get(file);
        if (stored && stored.size === meta.size && stored.mtimeMs === meta.mtimeMs) {
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
    // BATCHED: fetch all session_files meta in one round-trip and diff in TS.
    // Previously a per-file HTTP round-trip per session file (N+1) — on the
    // real 3515-file sessions dir this alone was ~11s/1107 round-trips, paid on
    // every session_start just to decide whether backfill was needed.
    const metaByPath = await this.fetchSessionFileMeta();
    for (const file of files) {
      try {
        const stat = fs.statSync(file);
        const stored = metaByPath.get(file);
        if (!(stored && stored.size === stat.size && stored.mtimeMs === Math.trunc(stat.mtimeMs))) return true;
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

  async recordAssembly(sessionId: string, mdIds: readonly string[], hash: string): Promise<void> {
    // Meta (hash) upsert + replace assembly rows. The session doc is never touched (hash lives
    // in session_assembly_meta; the sessions row is created later by backfill — see spec §Timing).
    await this.c.query(
      `UPSERT type::record("session_assembly_meta", $sid) SET sessionId = $sid, hash = $hash, capturedAt = $now;`,
      { sid: sessionId, hash, now: new Date().toISOString() },
    );
    await this.c.query(`DELETE FROM session_assembly WHERE sessionId = $sid;`, { sid: sessionId });
    const unique = [...new Set(mdIds)];
    if (unique.length === 0) return;
    const params: Record<string, unknown> = { sid: sessionId };
    const stmts = unique.map((id, i) => {
      params[`m${i}`] = id;
      return `CREATE session_assembly SET sessionId = $sid, mdId = $m${i};`;
    });
    await this.c.query(stmts.join("\n"), params);
  }

  // -------------------------------------------------------------------------
  // markUsed — UPSP §9 "used vs dropped" signal (stamp usedAt on referenced
  // rows). Surreal parity with the SQLite impl (Task 3); SCHEMALESS (no DDL).
  // ------------------------------------------------------------------------

  /**
   * UPDATE in place: stamp `usedAt` on the surfaced `(sessionId, mdId)` rows
   * the agent's output actually referenced. Sets ONLY matched rows for that
   * session; non-matched rows stay without the field (Surreal is SCHEMALESS →
   * absent ≈ null). Idempotent (a re-mark re-stamps). Empty `mdIds` is a no-op
   * (skips the query). NEVER touches `session_assembly_meta` or any other
   * table. `usedAt` (camelCase) matches the existing sessionId/mdId/capturedAt
   * convention; `IN $ids` binds the array directly — the same idiom the
   * surreal-memory-repo `seq NOT IN $seedSeqs` query uses (Surreal binds arrays
   * to `IN $param`, unlike SQLite's dynamic `?` placeholders). The SurrealClient
   * owns transient retry, so like `recordAssembly` there is no extra envelope.
   */
  async markUsed(sessionId: string, mdIds: readonly string[], usedAt: string): Promise<void> {
    if (mdIds.length === 0) return;
    await this.c.query(
      `UPDATE session_assembly SET usedAt = $now WHERE sessionId = $sid AND mdId IN $ids;`,
      { sid: sessionId, ids: mdIds, now: usedAt },
    );
  }

  // -------------------------------------------------------------------------
  // getUsedMdIds — UPSP §1/D4 boolean ever-used aggregate (Task 2 of #1b decay).
  // ------------------------------------------------------------------------

  /**
   * SELECT the distinct mdIds (out of the input set) that have ≥1
   * `session_assembly` row with `usedAt` set. The boolean ever-used signal (#06)
   * consumed by Task 3's heat-provider. One batched query; empty input → empty
   * Set (no-op, no SQL). The `session_assembly` table is GLOBAL (SCHEMALESS, no
   * project field) — `opts.project` is accepted but ignored (see the interface
   * JSDoc). Mirrors `markUsed`'s `IN $ids` array-bind idiom; a surfaced-but-never-
   * marked row has no `usedAt` field (absent = Surreal NONE — see the operator
   * note below). The SurrealClient owns transient retry, so like `markUsed` there
   * is no extra envelope. NEVER touches `session_assembly_meta` or any other table.
   */
  async getUsedMdIds(
    mdIds: string[],
    _opts: { project: string | null },
  ): Promise<Set<string>> {
    if (mdIds.length === 0) return new Set<string>();
    // NOTE: SurrealDB v3.2.3 does NOT support `SELECT DISTINCT` (parse error:
    // "Unexpected token, expected FROM"), so we project raw rows and dedupe into
    // the Set in TS. The (sessionId, mdId) PK means a used mdId may appear once
    // per session that surfaced+used it; the Set collapses them to a single entry
    // — the boolean ever-used aggregate (D4) needs only existence, not count.
    //
    // Operator: `recordAssembly` NEVER writes `usedAt`, so a surfaced-but-never-
    // marked row has the field ABSENT (Surreal NONE), not an SQL null. In v3.2.3
    // `usedAt IS NOT NULL` WRONGLY matches absent fields (NONE ≢ NULL here),
    // whereas `IS NOT NONE` correctly excludes them — verified live. Mirrors
    // markUsed's `IN $ids` array-bind idiom.
    const rows = await this.c.query<Array<{ mdId: string }>>(
      `SELECT mdId FROM session_assembly WHERE usedAt IS NOT NONE AND mdId IN $ids;`,
      { ids: mdIds },
    );
    return new Set(rows.map((r) => r.mdId));
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
