import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "../../src/store/sqlite/sqlite-memory-repo.js";
import {
  formatFailureMemoryContent,
  parseMarkdownMemoryEntry,
} from "../../src/store/memory-format.js";

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

  // ---------------------------------------------------------------------------
  // Ported from the deleted tests/store/sqlite-memory-store.test.ts (commit
  // 66d8a1d2). The old free-function API was positional:
  //   addMemory(dbManager, content, target?, project?, category?, ...)
  // These cases now exercise the async SqliteMemoryRepository object API.
  // Every assertion's intent is preserved verbatim — only the call shape moved.
  // ---------------------------------------------------------------------------

  describe("addMemory (ported)", () => {
    it("should add a memory entry", async () => {
      const entry = await repo.addMemory({ content: "prefers pnpm over npm" });
      expect(entry.id).toBeGreaterThan(0);
      expect(entry.target).toBe("memory");
      expect(entry.content).toBe("prefers pnpm over npm");
      expect(entry.created.length).toBeGreaterThan(0);
      expect(entry.lastReferenced.length).toBeGreaterThan(0);
    });

    it("should add a user entry", async () => {
      const entry = await repo.addMemory({ content: "name: Chandrateja", target: "user" });
      expect(entry.target).toBe("user");
    });

    it("should add a project-specific entry", async () => {
      const entry = await repo.addMemory({
        content: "uses Prisma",
        target: "memory",
        project: "my-project",
      });
      expect(entry.project).toBe("my-project");
    });

    it("should add a global entry (null project)", async () => {
      const entry = await repo.addMemory({ content: "timezone: AEST" });
      expect(entry.project).toBeNull();
    });
  });

  describe("syncMemoryEntry (ported)", () => {
    it("deduplicates exact logical entries", async () => {
      const first = await repo.syncMemoryEntry({
        content: "prefers pnpm over npm",
        target: "memory",
      });
      const second = await repo.syncMemoryEntry({
        content: "prefers pnpm over npm",
        target: "memory",
      });

      expect(first.action).toBe("inserted");
      expect(second.action).toBe("existing");
      const all = await repo.getMemories();
      expect(all).toHaveLength(1);
    });

    it("stores project-scoped memory with project name", async () => {
      await repo.syncMemoryEntry({
        content: "uses Prisma",
        target: "memory",
        project: "project-a",
      });

      const results = await repo.getMemories({ project: "project-a" });
      expect(results).toHaveLength(1);
      expect(results[0].project).toBe("project-a");
      expect(results[0].target).toBe("memory");
    });

    it("preserves failure category metadata", async () => {
      await repo.syncMemoryEntry({
        content: formatFailureMemoryContent("pnpm lockfile mismatch", {
          category: "tool-quirk",
          failureReason: "npm install rewrote lockfile",
        }),
        target: "failure",
        category: "tool-quirk",
        failureReason: "npm install rewrote lockfile",
      });

      const results = await repo.getMemories({ target: "failure", category: "tool-quirk" });
      expect(results).toHaveLength(1);
      expect(results[0].category).toBe("tool-quirk");
      expect(results[0].failureReason).toBe("npm install rewrote lockfile");
    });

    it("parses Markdown failure entries for backfill", () => {
      const parsed = parseMarkdownMemoryEntry(
        "[correction] use pnpm — Failed: npm install rewrote lockfile <!-- created=2026-05-08, last=2026-05-09 -->",
        "failure",
      );

      expect(parsed.category).toBe("correction");
      expect(parsed.failureReason).toBe("npm install rewrote lockfile");
      expect(parsed.created).toBe("2026-05-08");
      expect(parsed.lastReferenced).toBe("2026-05-09");
    });
  });

  describe("replace/remove synced memories (ported)", () => {
    it("escapes % and _ during replace matching", async () => {
      await repo.addMemory({ content: "token 100%_safe value" });
      await repo.addMemory({ content: "token 100XXsafe value" });

      const result = await repo.replaceSyncedMemories("100%_safe", {
        content: "token updated literal value",
        target: "memory",
        project: null,
      });

      expect(result.matched).toBe(1);
      const all = await repo.getMemories();
      expect(all.some((entry) => entry.content === "token updated literal value")).toBe(true);
      expect(all.some((entry) => entry.content === "token 100XXsafe value")).toBe(true);
    });

    it("escapes % and _ during remove matching", async () => {
      await repo.addMemory({ content: "remove 50%_match literal" });
      await repo.addMemory({ content: "remove 50AAmatch literal" });

      const result = await repo.removeSyncedMemories("50%_match", {
        target: "memory",
        project: null,
      });

      expect(result.matched).toBe(1);
      const all = await repo.getMemories();
      expect(all).toHaveLength(1);
      expect(all[0].content).toBe("remove 50AAmatch literal");
    });

    it("normalizes pasted memory_search lines during replace matching", async () => {
      await repo.addMemory({ content: "prefers pnpm over npm" });

      const result = await repo.replaceSyncedMemories(
        "🧠 [global] prefers pnpm over npm\n   Created: 2026-05-27 | Last used: 2026-05-27",
        {
          content: "prefers pnpm over npm and bun when needed",
          target: "memory",
          project: null,
        },
      );

      expect(result.matched).toBe(1);
      const all = await repo.getMemories();
      expect(all.some((entry) => entry.content === "prefers pnpm over npm and bun when needed")).toBe(true);
    });

    it("normalizes pasted memory_search lines during remove matching", async () => {
      await repo.addMemory({
        content: "[correction] use pnpm — Failed: npm rewrote the lockfile",
        target: "failure",
      });

      const result = await repo.removeSyncedMemories(
        "⚠️ [global] [correction] [correction] use pnpm\n   Created: 2026-05-27 | Last used: 2026-05-27",
        {
          target: "failure",
          project: null,
        },
      );

      expect(result.matched).toBe(1);
      const all = await repo.getMemories();
      expect(all).toHaveLength(0);
    });
  });

  describe("searchMemories (ported)", () => {
    beforeEach(async () => {
      await repo.addMemory({ content: "prefers pnpm over npm" });
      await repo.addMemory({ content: "uses Prisma with PostgreSQL", target: "memory", project: "project-a" });
      await repo.addMemory({ content: "debugged gpu timeout issue after driver update" });
      await repo.addMemory({ content: "memory search indexing notes" });
      await repo.addMemory({ content: "exact phrase memory search example" });
      await repo.addMemory({ content: "name: Chandrateja", target: "user" });
      await repo.addMemory({ content: "timezone: AEST", target: "user" });
    });

    it("should find memories by keyword", async () => {
      const results = await repo.searchMemories("pnpm");
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.content.includes("pnpm"))).toBe(true);
    });

    it("should find memories by partial content", async () => {
      const results = await repo.searchMemories("Prisma");
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.content.includes("Prisma"))).toBe(true);
    });

    it("should match multi-word queries without requiring an exact phrase", async () => {
      const results = await repo.searchMemories("gpu issue");
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.content.includes("gpu timeout issue"))).toBe(true);
    });

    it("should ignore lowercase connector words in natural-language queries", async () => {
      const results = await repo.searchMemories("gpu and issue");
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.content.includes("gpu timeout issue"))).toBe(true);
    });

    it("should fall back to broader natural-language matching when strict term matching misses", async () => {
      await repo.addMemory({ content: "user's name is Naruto", target: "user" });

      const results = await repo.searchMemories("name identity Naruto", { target: "user" });

      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.content.includes("Naruto"))).toBe(true);
    });

    it("should not broaden explicit operator queries", async () => {
      const results = await repo.searchMemories("pnpm AND nonexistent");
      expect(results).toHaveLength(0);
    });

    it("should preserve explicit quoted phrase searches", async () => {
      const results = await repo.searchMemories('"memory search"');
      expect(results.length).toBeGreaterThan(0);
      // Graph-augmented recall may surface tag-sharing neighbors after the
      // phrase match; assert the phrase match is present, not exclusive.
      expect(results.some((r) => r.content.includes("memory search"))).toBe(true);
    });

    it("should preserve valid operator queries", async () => {
      const results = await repo.searchMemories("pnpm OR AEST");
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.some((r) => r.content.includes("pnpm"))).toBe(true);
      expect(results.some((r) => r.content.includes("AEST"))).toBe(true);
    });

    it("should limit results", async () => {
      const results = await repo.searchMemories("pnpm OR Prisma OR AEST", { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("should filter by project", async () => {
      const results = await repo.searchMemories("Prisma", { project: "project-a" });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.project === "project-a")).toBe(true);
    });

    it("should filter by target", async () => {
      const results = await repo.searchMemories("Chandrateja OR AEST", { target: "user" });
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((r) => r.target === "user")).toBe(true);
    });

    it("should return empty for no matches", async () => {
      const results = await repo.searchMemories("nonexistent-xyz");
      expect(results).toHaveLength(0);
    });

    it("should return empty for blank queries", async () => {
      const results = await repo.searchMemories("   ");
      expect(results).toEqual([]);
    });

    it("should not throw on unmatched quotes", async () => {
      const results = await repo.searchMemories('issue "timeout');
      expect(Array.isArray(results)).toBe(true);
    });

    it("should return empty for malformed operator queries", async () => {
      const results = await repo.searchMemories("AND OR NOT");
      expect(results).toHaveLength(0);
    });
  });

  describe("getMemories (ported)", () => {
    beforeEach(async () => {
      await repo.addMemory({ content: "global memory 1" });
      await repo.addMemory({ content: "global memory 2" });
      await repo.addMemory({ content: "project memory", target: "memory", project: "project-a" });
      await repo.addMemory({ content: "user preference", target: "user" });
    });

    it("should return all memories", async () => {
      const results = await repo.getMemories();
      expect(results).toHaveLength(4);
    });

    it("should filter by project", async () => {
      const results = await repo.getMemories({ project: "project-a" });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("project memory");
    });

    it("should filter by null project (global)", async () => {
      const results = await repo.getMemories({ project: null });
      expect(results).toHaveLength(3);
    });

    it("should filter by target", async () => {
      const results = await repo.getMemories({ target: "user" });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe("user preference");
    });
  });

  describe("removeMemory (ported)", () => {
    it("should remove a memory by id", async () => {
      const entry = await repo.addMemory({ content: "to be removed" });
      const removed = await repo.removeMemory(entry.id);
      expect(removed).toBe(true);

      const all = await repo.getMemories();
      expect(all).toHaveLength(0);
    });

    it("should return false for non-existent id", async () => {
      const removed = await repo.removeMemory(99999);
      expect(removed).toBe(false);
    });
  });

  describe("touchMemory (ported)", () => {
    it("should update last_referenced date", async () => {
      const entry = await repo.addMemory({ content: "old memory" });
      // Manually set an old date
      const db = backend.getDb();
      db.prepare("UPDATE memories SET last_referenced = ? WHERE id = ?").run("2020-01-01", entry.id);

      await repo.touchMemory(entry.id);

      const updated = db.prepare("SELECT last_referenced FROM memories WHERE id = ?").get(entry.id) as {
        last_referenced: string;
      };
      const today = new Date().toISOString().split("T")[0];
      expect(updated.last_referenced).toBe(today);
    });
  });

  describe("getMemoryStats (ported)", () => {
    it("should return zero stats for empty database", async () => {
      const stats = await repo.getMemoryStats();
      expect(stats.total).toBe(0);
      expect(stats.byProject).toEqual([]);
      expect(stats.byTarget).toEqual([]);
    });

    it("should return correct stats", async () => {
      await repo.addMemory({ content: "global 1" });
      await repo.addMemory({ content: "global 2" });
      await repo.addMemory({ content: "project memory", target: "memory", project: "project-a" });
      await repo.addMemory({ content: "user pref", target: "user" });

      const stats = await repo.getMemoryStats();
      expect(stats.total).toBe(4);
      expect(stats.byTarget).toHaveLength(2);
      expect(stats.byProject.length).toBeGreaterThan(0);
    });
  });

  it("addMemory seeds mwSuccess/mwFail = 0; bumpMemoryWorth increments them", async () => {
    const entry = await repo.addMemory({ content: "worth-test", target: "memory" });
    expect(entry.mwSuccess).toBe(0);
    expect(entry.mwFail).toBe(0);
    await repo.bumpMemoryWorth(entry.id, 3, 1);
    const list = await repo.getMemories({ target: "memory" });
    const found = list.find((m) => m.id === entry.id)!;
    expect(found.mwSuccess).toBe(3);
    expect(found.mwFail).toBe(1);
  });

  it("syncMemoryEntry seeds worth from input on insert; merge preserves DB worth", async () => {
    const ins = await repo.syncMemoryEntry({ content: "seeded", target: "memory", mwSuccess: 2, mwFail: 0 });
    expect(ins.entry.mwSuccess).toBe(2);
    await repo.bumpMemoryWorth(ins.entry.id, 1, 0); // DB now 3
    // re-sync (merge path) must NOT overwrite the bumped DB counter
    await repo.syncMemoryEntry({ content: "seeded", target: "memory", mwSuccess: 2, mwFail: 0 });
    const list = await repo.getMemories({ target: "memory" });
    const found = list.find((m) => m.id === ins.entry.id)!;
    expect(found.mwSuccess).toBe(3);
  });

  it("no-neighbor search applies the worth multiplier (fast-path closed)", async () => {
    // Two query-matching entries in DIFFERENT projects (no shared graph
    // neighbor) → the no-neighbor fast path. NOTE: `low` is inserted FIRST so
    // it has the lower rowid; because last_referenced is day-granular (both
    // land on today), the raw `last_referenced DESC` fast path ties and
    // resolves rowid-asc → [low, high]. Closing the fast path routes through
    // rankMemoryEntries, whose worth multiplier must flip the order →
    // [high, low]. (The brief's literal insertion order happened to coincide
    // with the worth order on the tie, so it could not distinguish the two
    // paths — hence the swap.)
    const low = await repo.addMemory({ content: "deploy via bun y", target: "memory", project: "p-low" });
    const high = await repo.addMemory({ content: "deploy via bun x", target: "memory", project: "p-high" });
    await repo.bumpMemoryWorth(high.id, 8, 0); // boost high (success-heavy)
    await repo.bumpMemoryWorth(low.id, 0, 8); // sink low (fail-heavy)
    const hits = await repo.searchMemories("deploy bun", { limit: 10 });
    const highIdx = hits.findIndex((h) => h.id === high.id);
    const lowIdx = hits.findIndex((h) => h.id === low.id);
    expect(highIdx).toBeGreaterThanOrEqual(0);
    expect(lowIdx).toBeGreaterThanOrEqual(0);
    expect(highIdx).toBeLessThan(lowIdx); // high-worth ranks above low-worth
  });
});
