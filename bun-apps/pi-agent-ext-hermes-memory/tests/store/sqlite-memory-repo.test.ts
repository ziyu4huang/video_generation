import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "../../src/store/sqlite/sqlite-memory-repo.js";

describe("SqliteMemoryRepository", () => {
  let dir: string;
  let backend: SqliteBackend;
  let repo: SqliteMemoryRepository;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "hm-mem-"));
    backend = new SqliteBackend(dir);
    await backend.init();
    repo = new SqliteMemoryRepository(backend);
  });

  afterEach(() => {
    backend.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("addMemory + getMemories round-trip", async () => {
    const entry = await repo.addMemory({ content: "use pnpm not npm", target: "failure" });
    expect(entry.id).toBeGreaterThan(0);
    const list = await repo.getMemories({ target: "failure" });
    expect(list).toHaveLength(1);
    expect(list[0].content).toBe("use pnpm not npm");
  });

  it("syncMemoryEntry is idempotent (dedup)", async () => {
    const a = await repo.syncMemoryEntry({ content: "x", target: "memory" });
    const b = await repo.syncMemoryEntry({ content: "x", target: "memory" });
    expect(a.action).toBe("inserted");
    expect(b.action).toBe("existing");
    expect(a.entry.id).toBe(b.entry.id);
  });

  it("searchMemories recalls by term", async () => {
    await repo.addMemory({ content: "the quick brown fox", target: "memory" });
    const hits = await repo.searchMemories("quick");
    expect(hits).toHaveLength(1);
  });
});
