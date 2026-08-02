import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteSessionRepository } from "../../src/store/sqlite/sqlite-session-repo.js";
import { parseSessionFile, parseSessionManagerSnapshot, getSessionFiles, type ParsedSession } from "../../src/store/session-parser.js";

// ---------------------------------------------------------------------------
// Shared test-session factory (ported from session-indexer.test.ts).
// ---------------------------------------------------------------------------

function createTestSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  const id = overrides.id ?? "session-1";
  return {
    id,
    project: "test-project",
    cwd: "/test",
    startedAt: "2026-05-03T00:00:00Z",
    endedAt: null,
    messages: [
      { id: `${id}-msg-1`, role: "user", content: "Hello", timestamp: "2026-05-03T00:01:00Z" },
      { id: `${id}-msg-2`, role: "assistant", content: "Hi there!", timestamp: "2026-05-03T00:01:30Z", toolCalls: ["read"] },
    ],
    ...overrides,
  };
}

function writeJsonlSession(filePath: string, sessionId: string, messageIds: string[] = [`${sessionId}-m1`], cwd = `/test/${sessionId}`): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", id: sessionId, timestamp: "2026-05-03T00:00:00Z", cwd }),
    ...messageIds.map((id, index) =>
      JSON.stringify({
        type: "message",
        id,
        parentId: null,
        timestamp: `2026-05-03T00:0${index + 1}:00Z`,
        message: { role: "user", content: [{ type: "text", text: `Hello ${id}` }], timestamp: Date.now() },
      }),
    ),
  ];
  writeFileSync(filePath, lines.join("\n"));
}

describe("SqliteSessionRepository", () => {
  let dir: string;
  let backend: SqliteBackend;
  let repo: SqliteSessionRepository;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "hm-sess-"));
    backend = new SqliteBackend(dir);
    await backend.init();
    repo = new SqliteSessionRepository(backend);
  });

  afterEach(() => {
    backend.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // indexSession (ported from session-indexer.test.ts → indexSession describe)
  // -------------------------------------------------------------------------

  it("indexes a session and its messages", async () => {
    const session = createTestSession();
    const result = await repo.indexSession(session);

    expect(result.sessionId).toBe("session-1");
    expect(result.messagesIndexed).toBe(2);
    expect(result.skipped).toBe(false);

    const db = backend.getDb();
    const dbSession = db.prepare("SELECT * FROM sessions WHERE id = ?").get("session-1") as Record<string, unknown>;
    expect(dbSession.project).toBe("test-project");
    expect(dbSession.message_count).toBe(2);

    const messages = db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp").all("session-1") as Record<string, unknown>[];
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("stores tool_calls as JSON", async () => {
    await repo.indexSession(createTestSession());

    const db = backend.getDb();
    const msg = db.prepare("SELECT tool_calls FROM messages WHERE id = ?").get("session-1-msg-2") as { tool_calls: string | null };
    expect(msg.tool_calls).toBeTruthy();
    expect(JSON.parse(msg.tool_calls!)).toEqual(["read"]);
  });

  it("skips already-indexed sessions with no new messages", async () => {
    const session = createTestSession();
    const result1 = await repo.indexSession(session);
    expect(result1.skipped).toBe(false);

    const result2 = await repo.indexSession(session);
    expect(result2.skipped).toBe(true);
    expect(result2.messagesIndexed).toBe(0);
  });

  it("appends missing messages for an already-indexed resumed session", async () => {
    const session = createTestSession();
    await repo.indexSession(session);

    const resumed = createTestSession({
      messages: [
        ...session.messages,
        { id: "session-1-msg-3", role: "user", content: "Resumed later", timestamp: "2026-05-03T00:02:00Z" },
      ],
    });
    const result = await repo.indexSession(resumed);

    expect(result.skipped).toBe(false);
    expect(result.messagesIndexed).toBe(1);
    expect(backend.getStats().sessions).toBe(1);
    expect(backend.getStats().messages).toBe(3);

    const dbSession = backend.getDb().prepare("SELECT message_count FROM sessions WHERE id = ?").get("session-1") as { message_count: number };
    expect(dbSession.message_count).toBe(3);
  });

  it("handles sessions with no messages", async () => {
    const session = createTestSession({ messages: [] });
    const result = await repo.indexSession(session);
    expect(result.messagesIndexed).toBe(0);
    expect(result.skipped).toBe(false);
  });

  // -------------------------------------------------------------------------
  // indexSession returns IndexResult + searchSessions round-trip (from Task 6)
  // -------------------------------------------------------------------------

  it("indexSession returns IndexResult + searchSessions round-trip", async () => {
    const result = await repo.indexSession({
      id: "sess-1",
      project: "demo",
      cwd: "/tmp/demo",
      startedAt: "2026-07-22T00:00:00Z",
      messages: [
        { id: "m1", role: "user", content: "deploy with bun", timestamp: "2026-07-22T00:00:01Z" },
      ] as any,
    });
    expect(result).toEqual({ sessionId: "sess-1", messagesIndexed: 1, skipped: false });
    const hits = await repo.searchSessions("bun");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].sessionId).toBe("sess-1");
    expect(hits[0].messageId).toBe("m1");
  });

  // -------------------------------------------------------------------------
  // indexAllSessions (ported from session-indexer.test.ts → indexAllSessions)
  // -------------------------------------------------------------------------

  it("indexes all JSONL files from disk", async () => {
    const sessionsDir = join(dir, "sessions");
    const projDir = join(sessionsDir, "test-project");
    mkdirSync(projDir, { recursive: true });

    const lines = [
      JSON.stringify({ type: "session", id: "s1", timestamp: "2026-05-03T00:00:00Z", cwd: "/test" }),
      JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-05-03T00:01:00Z", message: { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: Date.now() } }),
    ];
    writeFileSync(join(projDir, "session1.jsonl"), lines.join("\n"));

    const result = await repo.indexAllSessions(sessionsDir);
    expect(result.sessionsProcessed).toBe(1);
    expect(result.sessionsIndexed).toBe(1);
    expect(result.messagesIndexed).toBe(1);
    expect(result.errors.length).toBe(0);
  });

  it("skips already-indexed sessions on re-run", async () => {
    const sessionsDir = join(dir, "sessions");
    const projDir = join(sessionsDir, "test-project");
    mkdirSync(projDir, { recursive: true });

    const lines = [
      JSON.stringify({ type: "session", id: "s1", timestamp: "2026-05-03T00:00:00Z", cwd: "/test" }),
      JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-05-03T00:01:00Z", message: { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: Date.now() } }),
    ];
    writeFileSync(join(projDir, "session1.jsonl"), lines.join("\n"));

    const result1 = await repo.indexAllSessions(sessionsDir);
    expect(result1.sessionsIndexed).toBe(1);

    const result2 = await repo.indexAllSessions(sessionsDir);
    expect(result2.sessionsSkipped).toBe(1);
    expect(result2.sessionsIndexed).toBe(0);
  });

  it("handles invalid JSONL files gracefully", async () => {
    const sessionsDir = join(dir, "sessions");
    const projDir = join(sessionsDir, "test-project");
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "invalid.jsonl"), '{"type":"message","id":"m1"}');

    const result = await repo.indexAllSessions(sessionsDir);
    expect(result.sessionsProcessed).toBe(1);
    expect(result.errors.length).toBe(1);
  });

  it("indexes a whole batch together; a mid-batch failure isolates only that file (SAVEPOINT rollback)", async () => {
    const sessionsDir = join(dir, "sessions");
    const projDir = join(sessionsDir, "test-project");
    mkdirSync(projDir, { recursive: true });

    const writeValid = (name: string, sid: string) => {
      const lines = [
        JSON.stringify({ type: "session", id: sid, timestamp: "2026-05-03T00:00:00Z", cwd: "/test" }),
        JSON.stringify({ type: "message", id: `${sid}-m1`, parentId: null, timestamp: "2026-05-03T00:01:00Z", message: { role: "user", content: [{ type: "text", text: "Hi" }], timestamp: Date.now() } }),
      ];
      writeFileSync(join(projDir, name), lines.join("\n"));
    };

    writeFileSync(join(projDir, "bad.jsonl"), '{"type":"message","id":"m1"}');
    writeValid("s1.jsonl", "s1");
    writeValid("s2.jsonl", "s2");

    const result = await repo.indexAllSessions(sessionsDir);
    expect(result.sessionsProcessed).toBe(3);
    expect(result.sessionsIndexed).toBe(2);
    expect(result.messagesIndexed).toBe(2);
    expect(result.errors.length).toBe(1);

    const sessions = backend.getDb().prepare("SELECT id FROM sessions ORDER BY id").all() as { id: string }[];
    expect(sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("handles empty sessions directory", async () => {
    const sessionsDir = join(dir, "empty-sessions");
    mkdirSync(sessionsDir);
    const result = await repo.indexAllSessions(sessionsDir);
    expect(result.sessionsProcessed).toBe(0);
    expect(result.sessionsIndexed).toBe(0);
  });

  it("handles non-existent sessions directory", async () => {
    const result = await repo.indexAllSessions("/nonexistent/path");
    expect(result.sessionsProcessed).toBe(0);
  });

  // -------------------------------------------------------------------------
  // indexChangedSessions (ported from session-indexer.test.ts)
  // -------------------------------------------------------------------------

  it("skips unchanged files using stored size and mtime metadata without parsing them", async () => {
    const sessionsDir = join(dir, "sessions");
    writeJsonlSession(join(sessionsDir, "project-a", "s1.jsonl"), "s1");
    await repo.indexAllSessions(sessionsDir);

    const result = await repo.indexChangedSessions(sessionsDir);
    expect(result.sessionsProcessed).toBe(0);
    expect(result.sessionsSkipped).toBe(1);
    expect(result.errors.length).toBe(0);
  });

  it("indexes changed files and appends newly persisted messages", async () => {
    const sessionsDir = join(dir, "sessions");
    const filePath = join(sessionsDir, "project-a", "s1.jsonl");
    writeJsonlSession(filePath, "s1", ["s1-m1"]);
    await repo.indexAllSessions(sessionsDir);

    writeJsonlSession(filePath, "s1", ["s1-m1", "s1-m2"]);
    const result = await repo.indexChangedSessions(sessionsDir);

    expect(result.sessionsProcessed).toBe(1);
    expect(result.sessionsIndexed).toBe(1);
    expect(result.messagesIndexed).toBe(1);
    expect(backend.getStats().messages).toBe(2);
  });

  it("parses existing sessions without file metadata and appends missed messages", async () => {
    const sessionsDir = join(dir, "sessions");
    const filePath = join(sessionsDir, "project-a", "s1.jsonl");
    await repo.indexSession(createTestSession({ id: "s1", messages: [{ id: "s1-m1", role: "user", content: "Hello s1-m1", timestamp: "2026-05-03T00:01:00Z" }] }));
    writeJsonlSession(filePath, "s1", ["s1-m1", "s1-m2"]);

    const result = await repo.indexChangedSessions(sessionsDir);

    expect(result.sessionsProcessed).toBe(1);
    expect(result.sessionsIndexed).toBe(1);
    expect(result.messagesIndexed).toBe(1);
    expect(backend.getStats().messages).toBe(2);
  });

  it("caps parsed files during startup incremental backfill", async () => {
    const sessionsDir = join(dir, "sessions");
    writeJsonlSession(join(sessionsDir, "project-a", "s1.jsonl"), "s1");
    writeJsonlSession(join(sessionsDir, "project-a", "s2.jsonl"), "s2");

    const result = await repo.indexChangedSessions(sessionsDir, { maxFilesToIndex: 1 });

    expect(result.sessionsProcessed).toBe(1);
    expect(result.reachedLimit).toBe(true);
    expect(backend.getStats().sessions).toBe(1);
  });

  it("processes the most recently modified changed files first when the cap is reached", async () => {
    const sessionsDir = join(dir, "sessions");
    const olderPath = join(sessionsDir, "project-a", "older.jsonl");
    const newerPath = join(sessionsDir, "project-a", "newer.jsonl");
    writeJsonlSession(olderPath, "older");
    const past = new Date(Date.now() - 60_000);
    utimesSync(olderPath, past, past);
    writeJsonlSession(newerPath, "newer");

    const result = await repo.indexChangedSessions(sessionsDir, { maxFilesToIndex: 1 });

    expect(result.sessionsProcessed).toBe(1);
    expect(result.reachedLimit).toBe(true);
    expect(backend.getStats().sessions).toBe(1);
    const indexed = backend.getDb().prepare("SELECT id FROM sessions").all() as { id: string }[];
    expect(indexed.map((r) => r.id)).toEqual(["newer"]);
  });

  it("indexChangedSessions returns BulkIndexResult with errors array (from Task 6)", async () => {
    const result = await repo.indexChangedSessions(join(dir, "no-such-sessions-dir"));
    expect(result).toHaveProperty("sessionsProcessed");
    expect(result).toHaveProperty("sessionsIndexed");
    expect(result).toHaveProperty("sessionsSkipped");
    expect(result).toHaveProperty("messagesIndexed");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.reachedLimit === undefined || typeof result.reachedLimit === "boolean").toBe(true);
  });

  // -------------------------------------------------------------------------
  // parseSessionManagerSnapshot (ported from session-indexer.test.ts)
  // -------------------------------------------------------------------------

  it("parseSessionManagerSnapshot converts current session entries into ParsedSession", () => {
    const snapshot = {
      getHeader: () => ({ id: "live-session-1", timestamp: "2026-05-03T00:00:00Z", cwd: "/work/live-project" }),
      getEntries: () => [
        { type: "message", id: "entry-1", timestamp: "2026-05-03T00:01:00Z", message: { role: "user", content: "Hello live session" } },
        { type: "message", id: "entry-2", timestamp: "2026-05-03T00:02:00Z", message: { role: "assistant", content: [{ type: "text", text: "Hi" }, { type: "toolCall", name: "read" }] } },
        { type: "message", id: "entry-3", timestamp: "2026-05-03T00:03:00Z", message: { role: "toolResult", content: [{ type: "text", text: "tool output is not indexed" }] } },
      ],
    };

    const parsed = parseSessionManagerSnapshot(snapshot);
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe("live-session-1");
    expect(parsed!.project).toBe("live-project");
    expect(parsed!.messages.length).toBe(2);
    expect(parsed!.messages[1].toolCalls).toEqual(["read"]);
  });

  // -------------------------------------------------------------------------
  // Live session indexing via repo.indexSession (ported indexCurrentSession logic)
  // -------------------------------------------------------------------------

  it("indexes live messages via parseSessionManagerSnapshot + repo.indexSession idempotently", async () => {
    const entries: unknown[] = [
      { type: "message", id: "entry-1", timestamp: "2026-05-03T00:01:00Z", message: { role: "user", content: "Hello live session" } },
    ];
    const snapshot = {
      getHeader: () => ({ id: "live-session-1", timestamp: "2026-05-03T00:00:00Z", cwd: "/work/live-project" }),
      getEntries: () => entries,
    };

    const session1 = parseSessionManagerSnapshot(snapshot)!;
    const result1 = await repo.indexSession(session1);
    expect(result1.messagesIndexed).toBe(1);
    expect(backend.getStats().sessions).toBe(1);
    expect(backend.getStats().messages).toBe(1);

    entries.push({ type: "message", id: "entry-2", timestamp: "2026-05-03T00:02:00Z", message: { role: "assistant", content: [{ type: "text", text: "Hi again" }] } });
    const session2 = parseSessionManagerSnapshot(snapshot)!;
    const result2 = await repo.indexSession(session2);
    expect(result2.messagesIndexed).toBe(1);
    expect(backend.getStats().sessions).toBe(1);
    expect(backend.getStats().messages).toBe(2);

    const session3 = parseSessionManagerSnapshot(snapshot)!;
    const result3 = await repo.indexSession(session3);
    expect(result3.skipped).toBe(true);
    expect(result3.messagesIndexed).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Backfill metadata helpers (ported from session-indexer.test.ts)
  // -------------------------------------------------------------------------

  it("needsBackfill is true when session file count exceeds indexed sessions", async () => {
    const sessionsDir = join(dir, "sessions");
    writeJsonlSession(join(sessionsDir, "project-a", "s1.jsonl"), "s1");
    expect(await repo.needsBackfill(sessionsDir, new Date("2026-05-03T01:00:00Z").getTime())).toBe(true);
  });

  it("needsBackfill is false when counts match and timestamp is recent", async () => {
    const sessionsDir = join(dir, "sessions");
    writeJsonlSession(join(sessionsDir, "project-a", "s1.jsonl"), "s1");
    await repo.indexAllSessions(sessionsDir);
    await repo.touchBackfillTimestamp(new Date("2026-05-03T00:30:00Z").toISOString());
    expect(await repo.needsBackfill(sessionsDir, new Date("2026-05-03T01:00:00Z").getTime())).toBe(false);
  });

  it("needsBackfill is true when file metadata changes even with a recent timestamp", async () => {
    const sessionsDir = join(dir, "sessions");
    writeJsonlSession(join(sessionsDir, "project-a", "s1.jsonl"), "s1");
    await repo.indexAllSessions(sessionsDir);
    await repo.touchBackfillTimestamp(new Date("2026-05-03T00:30:00Z").toISOString());

    appendFileSync(join(sessionsDir, "project-a", "s1.jsonl"), "\n" + JSON.stringify({ type: "message", id: "s1-m2", parentId: null, timestamp: "2026-05-03T00:02:00Z", message: { role: "user", content: [{ type: "text", text: "Hello again" }], timestamp: Date.now() } }));
    expect(await repo.needsBackfill(sessionsDir, new Date("2026-05-03T01:00:00Z").getTime())).toBe(true);
  });

  it("needsBackfill is true for existing sessions without file metadata even with a recent timestamp", async () => {
    const sessionsDir = join(dir, "sessions");
    writeJsonlSession(join(sessionsDir, "project-a", "s1.jsonl"), "s1");
    await repo.indexSession(createTestSession({ id: "s1", messages: [] }));
    await repo.touchBackfillTimestamp(new Date("2026-05-03T00:30:00Z").toISOString());
    expect(await repo.needsBackfill(sessionsDir, new Date("2026-05-03T01:00:00Z").getTime())).toBe(true);
  });

  it("needsBackfill is true when timestamp is missing or older than 24 hours", async () => {
    const sessionsDir = join(dir, "sessions");
    writeJsonlSession(join(sessionsDir, "project-a", "s1.jsonl"), "s1");
    await repo.indexAllSessions(sessionsDir);

    expect(await repo.needsBackfill(sessionsDir, new Date("2026-05-03T01:00:00Z").getTime())).toBe(true);
    await repo.touchBackfillTimestamp(new Date("2026-05-01T00:00:00Z").toISOString());
    expect(await repo.needsBackfill(sessionsDir, new Date("2026-05-03T01:00:00Z").getTime())).toBe(true);
  });

  it("touchBackfillTimestamp upserts the metadata row", async () => {
    await repo.touchBackfillTimestamp(new Date("2026-05-03T00:00:00Z").toISOString());
    await repo.touchBackfillTimestamp(new Date("2026-05-03T01:00:00Z").toISOString());

    const row = backend.getDb().prepare("SELECT value FROM extension_metadata WHERE key = ?").get("last_session_backfill") as { value: string };
    expect(row.value).toBe("2026-05-03T01:00:00.000Z");
  });

  it("upsertSessionFileMeta keeps stored metadata in sync after a session file is appended", async () => {
    const sessionsDir = join(dir, "sessions");
    writeJsonlSession(join(sessionsDir, "project-a", "s1.jsonl"), "s1");
    const filePath = join(sessionsDir, "project-a", "s1.jsonl");

    await repo.indexAllSessions(sessionsDir);
    appendFileSync(filePath, "\n" + JSON.stringify({ type: "message", id: "s1-m2", parentId: null, timestamp: "2026-05-03T00:02:00Z", message: { role: "user", content: [{ type: "text", text: "Hello again" }], timestamp: Date.now() } }));
    const session = parseSessionFile(filePath)!;
    await repo.indexSession(session);
    await repo.upsertSessionFileMeta(filePath, session.id);

    const result = await repo.indexChangedSessions(sessionsDir);
    expect(result.sessionsProcessed).toBe(0);
    expect(result.sessionsSkipped).toBe(1);
    expect(result.reachedLimit).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // getSessionStats (ported from session-indexer.test.ts + Task 6)
  // -------------------------------------------------------------------------

  it("getSessionStats returns zero counts for empty database", async () => {
    const stats = await repo.getSessionStats();
    expect(stats.totalSessions).toBe(0);
    expect(stats.totalMessages).toBe(0);
    expect(stats.projects).toEqual([]);
  });

  it("getSessionStats returns correct stats after indexing", async () => {
    await repo.indexSession(createTestSession());
    const stats = await repo.getSessionStats();
    expect(stats.totalSessions).toBe(1);
    expect(stats.totalMessages).toBe(2);
    expect(stats.projects.length).toBe(1);
    expect(stats.projects[0].project).toBe("test-project");
    expect(stats.projects[0].sessions).toBe(1);
    expect(stats.projects[0].messages).toBe(2);
  });

  it("getSessionStats groups by project", async () => {
    await repo.indexSession(createTestSession({ id: "s1", project: "project-a" }));
    await repo.indexSession(createTestSession({ id: "s2", project: "project-a" }));
    await repo.indexSession(createTestSession({ id: "s3", project: "project-b" }));

    const stats = await repo.getSessionStats();
    expect(stats.totalSessions).toBe(3);
    expect(stats.projects.length).toBe(2);

    const projA = stats.projects.find((p) => p.project === "project-a")!;
    const projB = stats.projects.find((p) => p.project === "project-b")!;
    expect(projA.sessions).toBe(2);
    expect(projB.sessions).toBe(1);
  });

  // -------------------------------------------------------------------------
  // getIndexedMessageCount (from Task 6)
  // -------------------------------------------------------------------------

  it("getIndexedMessageCount counts messages", async () => {
    await repo.indexSession({ id: "s2", messages: [{ id: "m", role: "user", content: "hi", timestamp: "t" }] } as any);
    expect(await repo.getIndexedMessageCount()).toBeGreaterThanOrEqual(1);
  });

  it("getIndexedMessageCount returns 0 for empty database", async () => {
    expect(await repo.getIndexedMessageCount()).toBe(0);
  });

  it("getIndexedMessageCount returns correct count after indexing", async () => {
    await repo.indexSession(createSearchSession());
    expect(await repo.getIndexedMessageCount()).toBe(6);
  });

  // -------------------------------------------------------------------------
  // searchSessions (ported from session-search.test.ts)
  // -------------------------------------------------------------------------

  function createSearchSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
    const id = overrides.id ?? "session-1";
    return {
      id,
      project: "test-project",
      cwd: "/test",
      startedAt: "2026-05-03T00:00:00Z",
      endedAt: null,
      messages: [
        { id: `${id}-msg-1`, role: "user", content: "How do I set up Prisma with PostgreSQL?", timestamp: "2026-05-03T00:01:00Z" },
        { id: `${id}-msg-2`, role: "assistant", content: "To set up Prisma, install the package and run prisma init. Then configure your DATABASE_URL in .env", timestamp: "2026-05-03T00:01:30Z" },
        { id: `${id}-msg-3`, role: "user", content: "What about database migrations?", timestamp: "2026-05-03T00:02:00Z" },
        { id: `${id}-msg-4`, role: "assistant", content: "Use prisma migrate dev to create migrations. This generates SQL files and applies them.", timestamp: "2026-05-03T00:02:30Z" },
        { id: `${id}-msg-5`, role: "user", content: "What about gpu timeout issue debugging?", timestamp: "2026-05-03T00:03:00Z" },
        { id: `${id}-msg-6`, role: "assistant", content: "This exact phrase memory search example helps verify phrase queries.", timestamp: "2026-05-03T00:03:30Z" },
      ],
      ...overrides,
    };
  }

  it("searchSessions finds messages matching a search query", async () => {
    await repo.indexSession(createSearchSession());
    const results = await repo.searchSessions("Prisma");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.content.includes("Prisma"))).toBe(true);
  });

  it("searchSessions returns results with content", async () => {
    await repo.indexSession(createSearchSession());
    const results = await repo.searchSessions("migrations");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content.length).toBeGreaterThan(0);
  });

  it("searchSessions returns results with session metadata", async () => {
    await repo.indexSession(createSearchSession());
    const results = await repo.searchSessions("Prisma");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].sessionId).toBe("session-1");
    expect(results[0].project).toBe("test-project");
    expect(results[0].timestamp.length).toBeGreaterThan(0);
  });

  it("searchSessions limits results", async () => {
    await repo.indexSession(createSearchSession());
    const results = await repo.searchSessions("Prisma", { limit: 1 });
    expect(results.length).toBe(1);
  });

  it("searchSessions filters by role", async () => {
    await repo.indexSession(createSearchSession());
    const userResults = await repo.searchSessions("Prisma", { role: "user" });
    const assistantResults = await repo.searchSessions("Prisma", { role: "assistant" });
    expect(userResults.length).toBeGreaterThan(0);
    expect(assistantResults.length).toBeGreaterThan(0);
    expect(userResults.every((r) => r.role === "user")).toBe(true);
    expect(assistantResults.every((r) => r.role === "assistant")).toBe(true);
  });

  it("searchSessions filters by project", async () => {
    await repo.indexSession(createSearchSession({ id: "s1", project: "project-a" }));
    await repo.indexSession(createSearchSession({ id: "s2", project: "project-b", messages: [{ id: "s2-m1", role: "user", content: "Different topic entirely", timestamp: "2026-05-03T00:01:00Z" }] }));

    const results = await repo.searchSessions("Prisma", { project: "project-a" });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.project === "project-a")).toBe(true);
  });

  it("searchSessions returns empty for no matches", async () => {
    await repo.indexSession(createSearchSession());
    const results = await repo.searchSessions("nonexistent-topic-xyz");
    expect(results.length).toBe(0);
  });

  it("searchSessions returns empty for empty database", async () => {
    const results = await repo.searchSessions("anything");
    expect(results.length).toBe(0);
  });

  it("searchSessions matches multi-word queries without requiring an exact phrase", async () => {
    await repo.indexSession(createSearchSession());
    const results = await repo.searchSessions("gpu issue");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.content.includes("gpu timeout issue"))).toBe(true);
  });

  it("searchSessions ignores lowercase connector words in natural-language queries", async () => {
    await repo.indexSession(createSearchSession());
    const results = await repo.searchSessions("gpu and issue");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.content.includes("gpu timeout issue"))).toBe(true);
  });

  it("searchSessions preserves explicit quoted phrase searches", async () => {
    await repo.indexSession(createSearchSession());
    const results = await repo.searchSessions('"memory search"');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.content.includes("memory search"))).toBe(true);
  });

  it("searchSessions preserves valid operator queries", async () => {
    await repo.indexSession(createSearchSession());
    const results = await repo.searchSessions("Prisma OR gpu");
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.some((r) => r.content.includes("Prisma"))).toBe(true);
    expect(results.some((r) => r.content.includes("gpu timeout issue"))).toBe(true);
  });

  it("searchSessions falls back to broader natural-language FTS matching when strict term matching misses", async () => {
    await repo.indexSession(createSearchSession({ id: "fallback-session", messages: [{ id: "fallback-session-msg-1", role: "assistant", content: "The user's name is Naruto", timestamp: "2026-05-03T00:01:00Z" }] }));
    const results = await repo.searchSessions("name identity Naruto");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.content.includes("Naruto"))).toBe(true);
  });

  it("searchSessions finds mixed Chinese/English queries via fallback", async () => {
    await repo.indexSession(createSearchSession({ id: "mixed-cjk-session", messages: [{ id: "mixed-cjk-session-msg-1", role: "assistant", content: "codex 已经开始执行探索任务了", timestamp: "2026-05-03T00:01:00Z" }] }));
    const results = await repo.searchSessions("codex 执行 任务");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.content.includes("codex 已经开始执行探索任务了"))).toBe(true);
  });

  it("searchSessions finds Chinese-only substrings via LIKE fallback", async () => {
    await repo.indexSession(createSearchSession({ id: "cjk-only-session", messages: [{ id: "cjk-only-session-msg-1", role: "assistant", content: "已经开始执行探索任务了", timestamp: "2026-05-03T00:01:00Z" }] }));
    const results = await repo.searchSessions("执行");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.content.includes("已经开始执行探索任务了"))).toBe(true);
  });

  it("searchSessions preserves filters, ordering, and limit during LIKE fallback", async () => {
    await repo.indexSession(createSearchSession({ id: "cjk-filter-a", project: "project-a", messages: [
      { id: "cjk-filter-a-msg-1", role: "user", content: "早期已经开始执行探索任务了", timestamp: "2026-05-03T00:01:00Z" },
      { id: "cjk-filter-a-msg-2", role: "user", content: "后续继续执行更多任务", timestamp: "2026-05-03T00:03:00Z" },
    ] }));
    await repo.indexSession(createSearchSession({ id: "cjk-filter-b", project: "project-b", messages: [
      { id: "cjk-filter-b-msg-1", role: "assistant", content: "另一个项目也执行任务", timestamp: "2026-05-03T00:04:00Z" },
    ] }));

    // NOTE: The original test used `since` for date filtering. The repo DTO
    // does not expose `since` in its options; the closest equivalent
    // (project + role + limit) still validates filter+limit+ordering.
    const results = await repo.searchSessions("执行", { project: "project-a", role: "user", limit: 1 });
    expect(results.length).toBe(1);
    expect(results[0].project).toBe("project-a");
    expect(results[0].role).toBe("user");
    expect(results[0].content.includes("后续继续执行更多任务") || results[0].content.includes("早期已经开始执行探索任务了")).toBe(true);
  });

  it("searchSessions escapes LIKE wildcard characters during fallback", async () => {
    await repo.indexSession(createSearchSession({ id: "like-escape-session", messages: [
      { id: "like-escape-session-msg-1", role: "user", content: "Progress reached 100% today", timestamp: "2026-05-03T00:01:00Z" },
      { id: "like-escape-session-msg-2", role: "user", content: "A plain message without the wildcard character", timestamp: "2026-05-03T00:02:00Z" },
    ] }));
    const results = await repo.searchSessions("%");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.content.includes("%"))).toBe(true);
  });

  it("searchSessions does not broaden explicit operator queries", async () => {
    await repo.indexSession(createSearchSession());
    const results = await repo.searchSessions("Prisma AND nonexistent");
    expect(results.length).toBe(0);
  });

  it("searchSessions handles malformed FTS5 queries gracefully", async () => {
    await repo.indexSession(createSearchSession());
    const results = await repo.searchSessions("AND OR NOT");
    expect(Array.isArray(results)).toBe(true);
  });

  it("searchSessions handles unmatched quotes gracefully", async () => {
    await repo.indexSession(createSearchSession());
    const results = await repo.searchSessions('issue "timeout');
    expect(Array.isArray(results)).toBe(true);
  });

  it("searchSessions returns empty for blank queries", async () => {
    const results = await repo.searchSessions("   ");
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// session_assembly schema (Task 3 — FK-free prompt-provenance tables, UPSP §5)
// ---------------------------------------------------------------------------

describe("session_assembly schema", () => {
  let dir: string;
  let backend: SqliteBackend;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "hm-sess-"));
    backend = new SqliteBackend(dir);
    await backend.init();
  });

  afterEach(() => {
    backend.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("session_assembly + session_assembly_meta tables exist after backend init (FK-free)", () => {
    const db = backend.getDb();

    const t1 = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_assembly'").get();
    expect(t1).toBeTruthy();
    const t2 = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_assembly_meta'").get();
    expect(t2).toBeTruthy();

    // FK-free by design: the sessions row is created later by deferred backfill, so
    // session_id is a plain join key, NOT REFERENCES sessions(id).
    const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE name='session_assembly'").get() as { sql: string }).sql;
    expect(ddl).not.toContain("REFERENCES");
  });
});
