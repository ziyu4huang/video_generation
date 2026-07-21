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

  it("indexSession + searchSessions round-trip", async () => {
    await repo.indexSession({
      id: "sess-1",
      project: "demo",
      cwd: "/tmp/demo",
      startedAt: "2026-07-22T00:00:00Z",
      messages: [
        { id: "m1", role: "user", content: "deploy with bun", timestamp: "2026-07-22T00:00:01Z" },
      ] as any,
    });
    const hits = await repo.searchSessions("bun");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].sessionId).toBe("sess-1");
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
});
