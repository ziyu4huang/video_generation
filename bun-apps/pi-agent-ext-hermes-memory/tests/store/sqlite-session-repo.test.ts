import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteSessionRepository } from "../../src/store/sqlite/sqlite-session-repo.js";

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

  it("getIndexedMessageCount counts messages", async () => {
    await repo.indexSession({
      id: "s2",
      messages: [
        { id: "m", role: "user", content: "hi", timestamp: "t" },
      ] as any,
    });
    expect(await repo.getIndexedMessageCount()).toBeGreaterThanOrEqual(1);
  });

  it("getSessionStats returns full shape (totals + projects)", async () => {
    await repo.indexSession({
      id: "sess-1",
      project: "demo",
      cwd: "/tmp/demo",
      startedAt: "2026-07-22T00:00:00Z",
      messages: [
        { id: "m1", role: "user", content: "hello", timestamp: "2026-07-22T00:00:01Z" },
      ] as any,
    });
    const stats = await repo.getSessionStats();
    expect(stats.totalSessions).toBeGreaterThanOrEqual(1);
    expect(stats.totalMessages).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(stats.projects)).toBe(true);
    expect(stats.projects.length).toBeGreaterThanOrEqual(1);
    expect(stats.projects[0]).toHaveProperty("project");
    expect(stats.projects[0]).toHaveProperty("sessions");
    expect(stats.projects[0]).toHaveProperty("messages");
  });

  it("indexChangedSessions returns BulkIndexResult with errors array", async () => {
    const result = await repo.indexChangedSessions(join(dir, "no-such-sessions-dir"));
    expect(result).toHaveProperty("sessionsProcessed");
    expect(result).toHaveProperty("sessionsIndexed");
    expect(result).toHaveProperty("sessionsSkipped");
    expect(result).toHaveProperty("messagesIndexed");
    expect(Array.isArray(result.errors)).toBe(true);
    // reachedLimit is optional (only set true when the cap is hit).
    expect(result.reachedLimit === undefined || typeof result.reachedLimit === "boolean").toBe(true);
  });
});
