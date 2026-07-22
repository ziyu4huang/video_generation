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

  // Regression for the async recovery-wrapping bug. The repo MUST compose
  // `runWithTransientRetry(() => this.backend.withCorruptionRecovery(() => body))`
  // (recovery INNER). `withCorruptionRecovery` is sync, so a sync corruption
  // throw from the bun:sqlite body must surface into its try/catch, trigger
  // `recoverFromCorruption`, and retry once — NOT escape as an unhandled
  // rejection. Under the OLD broken nesting (recovery OUTER, wrapping a
  // Promise-returning thunk) this test would FAIL: recovery never fires and
  // the corruption error propagates.
  it("corruption thrown mid-operation is caught + recovered through the repo method", async () => {
    // Seed a real memory so recovery has a readable row to preserve.
    await repo.addMemory({ content: "survives-recovery", target: "memory" });
    expect(backend.getLastRecovery()).toBeNull();

    // Instrument getDb so the FIRST call after this point throws a sync
    // SQLITE_CORRUPT. recoverFromCorruption closes + reopens cleanly; the
    // retry then reaches getDb again (firstCall already false) and succeeds.
    const realGetDb = backend.getDb.bind(backend);
    let firstCall = true;
    backend.getDb = () => {
      if (firstCall) {
        firstCall = false;
        const err = new Error("database disk image is malformed") as Error & { code: string };
        err.code = "SQLITE_CORRUPT";
        throw err;
      }
      return realGetDb();
    };

    // searchMemories must NOT throw — withCorruptionRecovery absorbs it.
    const hits = await repo.searchMemories("survives-recovery");
    expect(backend.getLastRecovery()?.strategy).toBe("rebuilt");
    // The rebuild copies readable rows, so the seeded memory survives.
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].content).toBe("survives-recovery");
  });
});
