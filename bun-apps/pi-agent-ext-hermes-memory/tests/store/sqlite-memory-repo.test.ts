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

  /**
   * `removed` / `setMdIdByContent` must report ROWS, not `.changes`.
   *
   * bun:sqlite counts trigger-written rows in `Statement.run().changes`, and
   * `memories` carries FTS5 sync triggers — so the old implementation reported
   * 9 for a single-row write, and disagreed with the Surreal backend, which
   * returns a real row count for the same interface. Every assertion below
   * compares against the ACTUAL table delta so it can never be satisfied by an
   * inflated number.
   */
  describe("row counts are real row counts (not bun:sqlite .changes)", () => {
    const count = () => (backend as unknown as { db: { prepare(q: string): { get(): { n: number } } } }).db
      .prepare("SELECT COUNT(*) AS n FROM memories").get().n;

    it("removeSyncedMemories: removed === the real table delta", async () => {
      for (const c of ["alpha one", "alpha two", "beta"]) await repo.addMemory({ content: c, target: "memory" });
      const before = count();
      const res = await repo.removeSyncedMemories("alpha", { target: "memory" });
      expect(res).toEqual({ matched: 2, removed: 2 });
      expect(before - count()).toBe(res.removed);
    });

    it("removeExactSyncedMemories: removed === the real table delta", async () => {
      await repo.addMemory({ content: "exact", target: "memory" });
      const before = count();
      const res = await repo.removeExactSyncedMemories("exact", { target: "memory" });
      expect(res).toEqual({ matched: 1, removed: 1 });
      expect(before - count()).toBe(1);
    });

    it("removeByMdId: removed === the real table delta", async () => {
      await repo.addMemory({ content: "keyed", target: "memory" });
      await repo.setMdIdByContent("keyed", "md-1", { target: "memory" });
      const before = count();
      const res = await repo.removeByMdId("md-1", { target: "memory" });
      expect(res).toEqual({ matched: 1, removed: 1 });
      expect(before - count()).toBe(1);
    });

    it("setMdIdByContent returns the number of rows it stamped", async () => {
      await repo.addMemory({ content: "one", target: "memory" });
      expect(await repo.setMdIdByContent("one", "md-a", { target: "memory" })).toBe(1);
      expect(await repo.setMdIdByContent("no-such-content", "md-b", { target: "memory" })).toBe(0);
    });

    it("a no-match remove reports {matched:0, removed:0} and deletes nothing", async () => {
      await repo.addMemory({ content: "survivor", target: "memory" });
      const before = count();
      expect(await repo.removeSyncedMemories("nope", { target: "memory" })).toEqual({ matched: 0, removed: 0 });
      expect(count()).toBe(before);
    });
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

  // ---------------------------------------------------------------------------
  // getRecentFailures — failure state filter (Task 3 of hermes-failure-lifecycle).
  // Injection must surface only `active` failures; resolved/acquired retire.
  // ---------------------------------------------------------------------------

  describe("getRecentFailures — failure state filter (Task 3)", () => {
    it("excludes resolved/acquired; keeps active; round-trips state", async () => {
      await repo.addMemory({ content: "[failure] active one", target: "failure", category: "failure", state: "active" });
      await repo.addMemory({ content: "[failure] fixed one", target: "failure", category: "failure", state: "resolved" });
      await repo.addMemory({ content: "[tool-quirk] known quirk", target: "failure", category: "tool-quirk", state: "acquired" });
      const recent = await repo.getRecentFailures(7);
      const contents = recent.map((m) => m.content);
      expect(contents.some((c) => c === "[failure] active one")).toBe(true);
      expect(contents.some((c) => c === "[failure] fixed one")).toBe(false);
      expect(contents.some((c) => c === "[tool-quirk] known quirk")).toBe(false);
      const active = recent.find((m) => m.content === "[failure] active one");
      expect(active?.state).toBe("active");
    });
  });

  // ---------------------------------------------------------------------------
  // replaceSyncedMemories — carries failure state (Task 3 gap-fix): the replace
  // UPDATE must persist `state`/`severity` so an edit/replace keeps the .md↔DB
  // lifecycle consistent (the seam declared the fields; the UPDATE now writes them).
  // ---------------------------------------------------------------------------

  describe("replaceSyncedMemories — carries failure state (Task 3 gap-fix)", () => {
    it("replace writes explicit state onto the row; getRecentFailures reflects it", async () => {
      await repo.addMemory({ content: "[failure] live bug", target: "failure", category: "failure", state: "active" });
      // Before: surfaces as active.
      expect((await repo.getRecentFailures(7)).map((m) => m.content)).toContain("[failure] live bug");
      // Replace (edit) marking it resolved.
      await repo.replaceSyncedMemories("[failure] live bug", {
        content: "[failure] live bug — fixed",
        target: "failure",
        category: "failure",
        state: "resolved",
      });
      // After: the resolved row no longer surfaces in the active-only injection set.
      const recent = (await repo.getRecentFailures(7)).map((m) => m.content);
      expect(recent).not.toContain("[failure] live bug — fixed");
      // And reading the row directly shows state=resolved.
      const all = await repo.getMemories({ target: "failure" });
      expect(all.find((m) => m.content === "[failure] live bug — fixed")?.state).toBe("resolved");
    });

    it("replace with no explicit state inherits the row's prior state", async () => {
      await repo.addMemory({ content: "[failure] quirk A", target: "failure", category: "failure", state: "resolved" });
      await repo.replaceSyncedMemories("[failure] quirk A", {
        content: "[failure] quirk A — edited",
        target: "failure",
      });
      const all = await repo.getMemories({ target: "failure" });
      expect(all.find((m) => m.content === "[failure] quirk A — edited")?.state).toBe("resolved");
    });
  });

  // ---------------------------------------------------------------------------
  // bumpMemoryWorth — memworth.fail freeze (§3.6): a resolved/acquired failure
  // no longer "fails", so its fail counter stops incrementing (success unaffected).
  // ---------------------------------------------------------------------------

  describe("bumpMemoryWorth — memworth.fail freeze off-active (§3.6)", () => {
    it("increments mwFail for active; freezes for resolved/acquired", async () => {
      const active = await repo.addMemory({ content: "[failure] active", target: "failure", category: "failure", state: "active" });
      const resolved = await repo.addMemory({ content: "[failure] resolved", target: "failure", category: "failure", state: "resolved" });
      const acquired = await repo.addMemory({ content: "[tool-quirk] acquired", target: "failure", category: "tool-quirk", state: "acquired" });
      await repo.bumpMemoryWorth(active.id, 0, 1);
      await repo.bumpMemoryWorth(resolved.id, 0, 1);
      await repo.bumpMemoryWorth(acquired.id, 0, 1);
      const rows = await repo.getMemories({ target: "failure" });
      const byContent = (c: string) => rows.find((r) => r.content === c)!;
      expect(byContent("[failure] active").mwFail).toBe(1);
      expect(byContent("[failure] resolved").mwFail).toBe(0);
      expect(byContent("[tool-quirk] acquired").mwFail).toBe(0);
    });

    it("success still increments off-active (freeze is fail-only)", async () => {
      const resolved = await repo.addMemory({ content: "[failure] res-succ", target: "failure", category: "failure", state: "resolved" });
      await repo.bumpMemoryWorth(resolved.id, 1, 0);
      const row = (await repo.getMemories({ target: "failure" })).find((r) => r.content === "[failure] res-succ")!;
      expect(row.mwSuccess).toBe(1);
      expect(row.mwFail).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Supersession (Task 3): lineage columns on read + status filter + supersedeMemory.
  // ---------------------------------------------------------------------------

  describe("supersession (Task 3)", () => {
    it("addMemory surfaces status='active' + null lineage (defaults via mapRow)", async () => {
      const entry = await repo.addMemory({ content: "lineage-defaults", target: "memory" });
      // addMemory return carries the DB-seeded defaults (mirrors mwSuccess/mwFail).
      expect(entry.status).toBe("active");
      expect(entry.supersedes).toBeNull();
      expect(entry.supersededBy).toBeNull();
      expect(entry.parentIds).toEqual([]);
      // Read back through mapRow to confirm DB defaults round-trip identically.
      const list = await repo.getMemories({ target: "memory" });
      const back = list.find((m) => m.id === entry.id)!;
      expect(back.status).toBe("active");
      expect(back.supersedes).toBeNull();
      expect(back.supersededBy).toBeNull();
      expect(back.parentIds).toEqual([]);
    });

    it("supersedeMemory flips prior lineage + sets new lineage", async () => {
      const prior = await repo.addMemory({ content: "deploy strategy alpha variant", target: "memory" });
      const next = await repo.addMemory({ content: "deploy strategy beta variant", target: "memory" });
      await repo.supersedeMemory(prior.id, next.id);

      const all = await repo.getMemories();
      const priorRow = all.find((m) => m.id === prior.id)!;
      const nextRow = all.find((m) => m.id === next.id)!;
      expect(priorRow.status).toBe("superseded");
      expect(priorRow.supersededBy).toBe(next.id);
      expect(nextRow.supersedes).toBe(prior.id);
      expect(nextRow.parentIds).toEqual([prior.id]);
    });

    it("searchMemories hides superseded prior by default, surfaces with includeSuperseded", async () => {
      const prior = await repo.addMemory({ content: "deploy strategy alpha variant", target: "memory" });
      const next = await repo.addMemory({ content: "deploy strategy beta variant", target: "memory" });
      await repo.supersedeMemory(prior.id, next.id);

      // Default: status='active' filter hides the superseded prior.
      const hidden = await repo.searchMemories("deploy strategy");
      expect(hidden.some((m) => m.id === prior.id)).toBe(false);
      expect(hidden.some((m) => m.id === next.id)).toBe(true);

      // Opt-in: includeSuperseded surfaces the prior again.
      const shown = await repo.searchMemories("deploy strategy", { includeSuperseded: true });
      expect(shown.some((m) => m.id === prior.id)).toBe(true);
      expect(shown.some((m) => m.id === next.id)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Task 2: Transactional supersedeMemory. The two UPDATEs (prior → superseded,
// new → supersedes+parentIds) must run inside a single BEGIN IMMEDIATE … COMMIT
// transaction so a crash between them cannot leave the prior half-superseded
// with no lineage link. The spy asserts runExclusive emits both markers.
// ---------------------------------------------------------------------------

describe("SqliteMemoryRepository.supersedeMemory atomicity", () => {
  let dir: string;
  let backend: SqliteBackend;
  let repo: SqliteMemoryRepository;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "supersede-tx-"));
    backend = new SqliteBackend(dir);
    await backend.init();
    repo = new SqliteMemoryRepository(backend);
  });
  afterEach(() => {
    backend.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs both UPDATEs inside a single BEGIN IMMEDIATE … COMMIT transaction", async () => {
    const prior = await repo.addMemory({ content: "prior atomic content", target: "memory" });
    const next = await repo.addMemory({ content: "next atomic content", target: "memory" });

    // Spy on db.exec to capture the transaction markers emitted by runExclusive.
    const db = backend.getDb();
    const execSqls: string[] = [];
    const origExec = db.exec.bind(db);
    db.exec = (sql: string) => {
      execSqls.push(sql);
      return origExec(sql);
    };

    try {
      await repo.supersedeMemory(prior.id, next.id);
    } finally {
      db.exec = origExec;
    }

    expect(execSqls.some((s) => s.toUpperCase().includes("BEGIN IMMEDIATE")))
      .toBe(true);
    expect(execSqls.some((s) => s.toUpperCase() === "COMMIT"))
      .toBe(true);
  });
});
