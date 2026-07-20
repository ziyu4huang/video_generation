/**
 * Unit tests for MemoryStore — core persistent memory with file-backed storage.
 *
 * Determinism: writes go to a per-test tmpdir (mkdtemp under os.tmpdir()),
 * never the real ~/.pi/agent/memory/. The tmpdir is passed as `memoryDir` so
 * MemoryStore resolves every file (MEMORY.md / USER.md / failures.md) inside
 * it; before/afterEach clean the slate and the whole dir is removed in after.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as assert from "node:assert/strict";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";


import { MemoryStore } from "../../src/store/memory-store.js";
import {
  ENTRY_DELIMITER,
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_USER_CHAR_LIMIT,
  MEMORY_FILE,
  USER_FILE,
} from "../../src/constants.js";
import type { MemoryConfig } from "../../src/types.js";

// ─── Helpers (module-level) ───

const TEST_MARKER = "[MEMORY-TEST]";
let MEMORY_DIR = "";

function makeConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
  return {
    memoryMode: "legacy-inject",
    memoryCharLimit: DEFAULT_MEMORY_CHAR_LIMIT,
    userCharLimit: DEFAULT_USER_CHAR_LIMIT,
    projectCharLimit: 5000,
    nudgeInterval: 10,
    reviewEnabled: false,
    flushOnCompact: false,
    flushOnShutdown: false,
    flushMinTurns: 6,
    autoConsolidate: false,
    correctionDetection: false,
    failureInjectionEnabled: true,
    failureInjectionMaxAgeDays: 7,
    failureInjectionMaxEntries: 5,
    nudgeToolCalls: 15,
    memoryDir: MEMORY_DIR,
    ...overrides,
  };
}

/** Read raw file content, return "" if missing. */
async function readRaw(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

/** Write a file (creating directories if needed). */
async function writeRaw(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

/** Delete a file, ignoring errors. */
async function removeFile(filePath: string): Promise<void> {
  try { await fs.unlink(filePath); } catch { /* ignore */ }
}

function dateDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split("T")[0];
}

function failureEntry(text: string, createdDaysAgo = 0): string {
  const date = dateDaysAgo(createdDaysAgo);
  return `${text} <!-- created=${date}, last=${date} -->`;
}

// ─── Tests ───

describe("MemoryStore", { concurrency: 1 }, () => {
  let memoryPath = "";
  let userPath = "";
  let failurePath = "";

  before(async () => {
    MEMORY_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "pi-memory-test-"));
    memoryPath = path.join(MEMORY_DIR, MEMORY_FILE);
    userPath = path.join(MEMORY_DIR, USER_FILE);
    failurePath = path.join(MEMORY_DIR, "failures.md");
  });

  after(async () => {
    // Clean up temp directory
    try {
      await fs.rm(MEMORY_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  /** Remove both memory files. No sleep is needed: every test awaits its
   *  mutations (add / replace / remove all await saveToDisk via runExclusive),
   *  so by the time this runs in before/afterEach no write is in flight. The
   *  old arbitrary setTimeout polls here were stale insurance from a prior
   *  fire-and-forget write design that no longer exists — they cost ~600ms per
   *  test (~24s across the suite) for nothing. */
  async function cleanSlate(): Promise<void> {
    await removeFile(memoryPath);
    await removeFile(userPath);
    await removeFile(failurePath);
  }

  beforeEach(async () => {
    await cleanSlate();
  });

  afterEach(async () => {
    await cleanSlate();
  });

  // ─── add() tests ───

  describe("add()", () => {
    it("persists entry to file and returns success with usage stats", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = await await store.add("memory", `${TEST_MARKER} project uses pnpm`);

      assert.ok(result.success);
      assert.equal(result.target, "memory");
      assert.ok(result.usage);
      assert.ok(result.usage!.includes("chars"));
      assert.equal(result.entry_count, 1);
      assert.equal(result.message, "Entry added.");
      assert.equal(result.entries, undefined);

      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(`${TEST_MARKER} project uses pnpm`));
    });

    it("no-ops on duplicate entry and returns message", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entry = `${TEST_MARKER} dup test entry`;
      const r1 = await store.add("memory", entry);
      assert.ok(r1.success);
      assert.equal(r1.entry_count, 1);

      const r2 = await store.add("memory", entry);

      assert.ok(r2.success);
      assert.equal(r2.entry_count, 1);
      assert.equal(r2.message, "Entry already exists (no duplicate added).");

      const raw = await readRaw(memoryPath);
      const count = raw.split(ENTRY_DELIMITER).filter(Boolean).length;
      assert.equal(count, 1);
    });

    it("returns error when content would exceed char limit", async () => {
      const store = new MemoryStore(makeConfig({ memoryCharLimit: 50 }));
      await store.loadFromDisk();

      const result = await await store.add("memory", `${TEST_MARKER} ${"x".repeat(60)}`);

      assert.ok(!result.success);
      assert.ok(result.error);
      assert.ok(result.error!.includes("exceed the limit"));
      assert.ok(result.error!.includes("chars"));
    });

    it("rejects without consolidation when memoryOverflowStrategy is reject", async () => {
      let consolidatorCalled = false;
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 50,
        memoryOverflowStrategy: "reject",
        autoConsolidate: true,
      }));
      store.setConsolidator(async () => {
        consolidatorCalled = true;
        return { consolidated: true };
      });
      await store.loadFromDisk();

      const result = await store.add("memory", `${TEST_MARKER} ${"x".repeat(60)}`);

      assert.ok(!result.success);
      assert.equal(consolidatorCalled, false);
      assert.ok(result.error!.includes("exceed the limit"));
    });

    it("evicts oldest entries in file order when memoryOverflowStrategy is fifo-evict", async () => {
      let consolidatorCalled = false;
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 150,
        memoryOverflowStrategy: "fifo-evict",
        autoConsolidate: true,
      }));
      store.setConsolidator(async () => {
        consolidatorCalled = true;
        return { consolidated: true };
      });
      await store.loadFromDisk();

      const first = `${TEST_MARKER} fifo first`;
      const second = `${TEST_MARKER} fifo second`;
      const next = `${TEST_MARKER} fifo next`;

      assert.ok((await store.add("memory", first)).success);
      assert.ok((await store.add("memory", second)).success);

      const result = await store.add("memory", next);

      assert.ok(result.success, result.error);
      assert.equal(consolidatorCalled, false);
      assert.equal(result.message, "Memory updated. Rotated 1 older entry to stay within the limit.");
      assert.deepEqual(result.evicted_entries, [first]);
      assert.equal(result.evicted_count, 1);
      assert.equal(result.entry_count, 2);

      const raw = await readRaw(memoryPath);
      assert.ok(!raw.includes(first));
      assert.ok(raw.includes(second));
      assert.ok(raw.includes(next));
      assert.ok(raw.indexOf(second) < raw.indexOf(next));
    });

    it("does not evict when the new entry cannot fit an empty memory", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 80,
        memoryOverflowStrategy: "fifo-evict",
      }));
      await store.loadFromDisk();

      const existing = `${TEST_MARKER} keep me`;
      assert.ok((await store.add("memory", existing)).success);

      const result = await store.add("memory", `${TEST_MARKER} ${"x".repeat(120)}`);

      assert.ok(!result.success);
      assert.ok(result.error!.includes("exceed the limit"));
      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(existing));
    });

    it("auto-consolidate floor: when consolidation frees nothing, vault-offloads oldest instead of hard-rejecting", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 200,
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      store.setConsolidator(async () => ({ consolidated: false }));
      await store.loadFromDisk();

      const first = `${TEST_MARKER} floor first oldest`;
      const second = `${TEST_MARKER} floor second`;
      const next = `${TEST_MARKER} floor next incoming`;
      assert.ok((await store.add("memory", first)).success);
      assert.ok((await store.add("memory", second)).success);

      const result = await store.add("memory", next);

      assert.ok(result.success, result.error);
      assert.equal(result.evicted_count, 1);
      assert.deepEqual(result.evicted_entries, [first]);
      assert.ok(result.archive_path, "floor should write a vault archive");

      const raw = await readRaw(memoryPath);
      assert.ok(!raw.includes(first), "oldest evicted to archive");
      assert.ok(raw.includes(second));
      assert.ok(raw.includes(next));
    });

    it("auto-consolidate floor: fires with no consolidator wired (never hard-rejects)", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 200,
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      // no setConsolidator — consolidator unavailable
      await store.loadFromDisk();

      const first = `${TEST_MARKER} nocons first`;
      const second = `${TEST_MARKER} nocons second`;
      const next = `${TEST_MARKER} nocons next`;
      assert.ok((await store.add("memory", first)).success);
      assert.ok((await store.add("memory", second)).success);

      const result = await store.add("memory", next);

      assert.ok(result.success, result.error);
      assert.equal(result.evicted_count, 1);
      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(next));
      assert.ok(raw.includes(second));
      assert.ok(!raw.includes(first));
    });

    it("auto-consolidate floor: a single entry larger than the whole budget still rejects", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 50,
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      store.setConsolidator(async () => ({ consolidated: false }));
      await store.loadFromDisk();

      const result = await store.add("memory", `${TEST_MARKER} ${"x".repeat(60)}`);

      assert.ok(!result.success);
      assert.ok(result.error!.includes("exceed the limit"));
    });

    it("returns error for empty content", async () => {
      const store = new MemoryStore(makeConfig());

      const result = await await store.add("memory", "   ");
      assert.ok(!result.success);
      assert.equal(result.error, "Content cannot be empty.");
    });

    it("writes to USER.md for 'user' target", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = await await store.add("user", `${TEST_MARKER} prefers dark mode`);

      assert.ok(result.success);
      assert.equal(result.target, "user");

      const raw = await readRaw(userPath);
      assert.ok(raw.includes(`${TEST_MARKER} prefers dark mode`));

      const memRaw = await readRaw(memoryPath);
      assert.equal(memRaw, "");
    });

    it("writes to MEMORY.md for 'memory' target", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = await await store.add("memory", `${TEST_MARKER} uses node 22`);

      assert.ok(result.success);
      assert.equal(result.target, "memory");

      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(`${TEST_MARKER} uses node 22`));
    });

    it("handles content with § delimiter in entry", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entry = `${TEST_MARKER} section divider${ENTRY_DELIMITER}continued`;
      const result = await await store.add("memory", entry);

      assert.ok(result.success);
      assert.equal(result.entry_count, 1);
    });

    it("handles unicode content", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entry = `${TEST_MARKER} 日本語テスト 🧪`;
      const result = await await store.add("memory", entry);

      assert.ok(result.success);
      assert.equal(result.entry_count, 1);
    });

    it("handles very long entry near char limit", async () => {
      const limit = 250;
      const store = new MemoryStore(makeConfig({ memoryCharLimit: limit }));
      await store.loadFromDisk();

      // Account for metadata overhead (~45 chars for <!-- created=..., last=... -->)
      const entry = `${TEST_MARKER} ${"a".repeat(limit - 100)}`;
      const result = await await store.add("memory", entry);

      assert.ok(result.success, `Expected success but got error: ${result.error}`);
    });

    it("handles sequential adds (two in sequence)", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const r1 = await store.add("memory", `${TEST_MARKER} first entry`);
      assert.ok(r1.success, `First add failed: ${r1.error}`);

      const r2 = await store.add("memory", `${TEST_MARKER} second entry`);
      assert.ok(r2.success, `Second add failed: ${r2.error}`);

      assert.equal(r2.entry_count, 2);

      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(`${TEST_MARKER} first entry`));
      assert.ok(raw.includes(`${TEST_MARKER} second entry`));
    });
  });

  describe("addFailure()", () => {
    it("applies failure-target char limits", async () => {
      const store = new MemoryStore(makeConfig({ memoryCharLimit: 40 }));
      await store.loadFromDisk();

      const result = await store.addFailure(`${TEST_MARKER} ${"x".repeat(120)}`, {
        category: "failure",
      });

      assert.ok(!result.success);
      assert.ok(result.error);
      assert.ok(result.error!.includes("exceed the limit"));
    });

    it("deduplicates exact failure memories", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const first = await store.addFailure(`${TEST_MARKER} use pnpm`, {
        category: "correction",
        failureReason: "npm rewrote the lockfile",
      });
      const second = await store.addFailure(`${TEST_MARKER} use pnpm`, {
        category: "correction",
        failureReason: "npm rewrote the lockfile",
      });

      assert.ok(first.success);
      assert.equal(first.message, "Failure memory saved: correction");
      assert.ok(second.success);
      assert.equal(second.message, "Entry already exists (no duplicate added).");
      assert.equal(second.entry_count, 1);

      const raw = await readRaw(failurePath);
      const count = raw.split(ENTRY_DELIMITER).filter(Boolean).length;
      assert.equal(count, 1);
    });
  });

  // ─── replace() tests ───

  describe("replace()", () => {
    it("updates entry in file", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} uses vim`);

      const result = await store.replace("memory", `${TEST_MARKER} uses vim`, `${TEST_MARKER} uses neovim`);

      assert.ok(result.success);
      assert.equal(result.message, "Entry replaced.");
      assert.equal(result.entries, undefined);

      const raw = await readRaw(memoryPath);
      assert.ok(!raw.includes(`${TEST_MARKER} uses vim`));
      assert.ok(raw.includes(`${TEST_MARKER} uses neovim`));
    });

    it("returns error when no match found", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} some entry`);

      const result = await store.replace("memory", "nonexistent substring", "new content");

      assert.ok(!result.success);
      assert.ok(result.error!.includes("No entry matched"));
    });

    it("returns error for multiple matches", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} config: port=8080`);
      await store.add("memory", `${TEST_MARKER} config: port=9090`);

      const result = await store.replace("memory", "config:", `${TEST_MARKER} unified config`);

      assert.ok(!result.success);
      assert.ok(result.error!.includes("Multiple entries matched"));
      assert.ok(result.matches);
      assert.equal(result.matches!.length, 2);
    });

    it("returns error for empty old_text", async () => {
      const store = new MemoryStore(makeConfig());
      await store.add("memory", `${TEST_MARKER} some entry`);

      const result = await store.replace("memory", "  ", "new content");

      assert.ok(!result.success);
      assert.equal(result.error, "old_text cannot be empty.");
    });

    it("returns error for empty new_content", async () => {
      const store = new MemoryStore(makeConfig());
      await store.add("memory", `${TEST_MARKER} some entry`);

      const result = await store.replace("memory", `${TEST_MARKER} some entry`, "   ");

      assert.ok(!result.success);
      assert.equal(result.error, "new_content cannot be empty. Use 'remove' to delete entries.");
    });

    it("replace() overflow with non-reject strategy vault-offloads oldest OTHER entries (never hard-rejects)", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 250,
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      await store.loadFromDisk();

      const oldest = `${TEST_MARKER} repl oldest evicted`;
      const mid = `${TEST_MARKER} repl mid keep`;
      const target = `${TEST_MARKER} repl target orig`;
      assert.ok((await store.add("memory", oldest)).success);
      assert.ok((await store.add("memory", mid)).success);
      assert.ok((await store.add("memory", target)).success);

      // Grow `target` so the replacement overflows; the floor must evict the
      // OLDEST OTHER entry (oldest), never the replaced one (target).
      const grown = `${TEST_MARKER} repl target grown ${"z".repeat(70)}`;
      const result = await store.replace("memory", target, grown);

      assert.ok(result.success, result.error);
      assert.equal(result.evicted_count, 1);
      assert.deepEqual(result.evicted_entries, [oldest], "evict oldest OTHER, not the replaced entry");

      const raw = await readRaw(memoryPath);
      assert.ok(!raw.includes(oldest), "oldest other evicted");
      assert.ok(raw.includes(grown), "replacement landed");
      assert.ok(raw.includes(mid), "unrelated entry kept");
      assert.ok(!raw.includes("repl target orig"), "old target text replaced away");
    });

    it("replace() overflow with reject strategy preserves the hard error", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 250,
        memoryOverflowStrategy: "reject",
        autoConsolidate: false,
      }));
      await store.loadFromDisk();

      const keep = `${TEST_MARKER} rj keep`;
      const target = `${TEST_MARKER} rj target`;
      assert.ok((await store.add("memory", keep)).success);
      assert.ok((await store.add("memory", target)).success);

      const result = await store.replace("memory", target, `${TEST_MARKER} ${"y".repeat(200)}`);

      assert.ok(!result.success);
      assert.ok(result.error!.includes("would put memory at"));
    });

    it("replace() a single replacement larger than the whole budget still rejects", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 100,
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      await store.loadFromDisk();
      assert.ok((await store.add("memory", `${TEST_MARKER} tiny`)).success);

      const result = await store.replace("memory", "tiny", `${TEST_MARKER} ${"w".repeat(60)}`);

      assert.ok(!result.success);
      assert.ok(result.error!.includes("exceed the limit"));
    });
  });

  // ─── remove() tests ───

  describe("remove()", () => {
    it("removes entry from file", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} to be removed`);
      await store.add("memory", `${TEST_MARKER} to keep`);

      const result = await store.remove("memory", `${TEST_MARKER} to be removed`);

      assert.ok(result.success);
      assert.equal(result.message, "Entry removed.");
      assert.equal(result.entry_count, 1);
      assert.equal(result.entries, undefined);

      const raw = await readRaw(memoryPath);
      assert.ok(!raw.includes(`${TEST_MARKER} to be removed`));
      assert.ok(raw.includes(`${TEST_MARKER} to keep`));
    });

    it("accepts a pasted memory_search line for normal memories", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} prefers pnpm over npm`);

      const result = await store.remove("memory", `🧠 [global] ${TEST_MARKER} prefers pnpm over npm\n   Created: 2026-05-27 | Last used: 2026-05-27`);

      assert.ok(result.success);
      const raw = await readRaw(memoryPath);
      assert.equal(raw.trim(), "");
    });

    it("accepts a pasted memory_search line for failure memories", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.addFailure(`${TEST_MARKER} use pnpm`, {
        category: "correction",
        failureReason: "npm rewrote the lockfile",
      });

      const result = await store.remove(
        "failure",
        `⚠️ [global] [correction] [correction] ${TEST_MARKER} use pnpm\n   Created: 2026-05-27 | Last used: 2026-05-27`,
      );

      assert.ok(result.success);
      const raw = await readRaw(failurePath);
      assert.equal(raw.trim(), "");
    });

    it("returns error when no match found", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} existing`);

      const result = await store.remove("memory", "nonexistent");

      assert.ok(!result.success);
      assert.ok(result.error!.includes("No entry matched"));
    });

    it("returns error for empty old_text", async () => {
      const store = new MemoryStore(makeConfig());
      await store.add("memory", `${TEST_MARKER} some entry`);

      const result = await store.remove("memory", "  ");

      assert.ok(!result.success);
      assert.equal(result.error, "old_text cannot be empty.");
    });
  });

  // ─── loadFromDisk() tests ───

  describe("loadFromDisk()", () => {
    it("reads existing MEMORY.md and USER.md correctly", async () => {
      // beforeEach already cleaned slate; write test data
      await writeRaw(memoryPath, `${TEST_MARKER} mem entry 1${ENTRY_DELIMITER}${TEST_MARKER} mem entry 2`);
      await writeRaw(userPath, `${TEST_MARKER} user entry 1`);

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const memEntries = store.getMemoryEntries();
      const userEntries = store.getUserEntries();

      assert.deepEqual(memEntries, [`${TEST_MARKER} mem entry 1`, `${TEST_MARKER} mem entry 2`]);
      assert.deepEqual(userEntries, [`${TEST_MARKER} user entry 1`]);
    });

    it("handles missing files gracefully (returns empty)", async () => {
      // beforeEach cleaned slate — files should not exist
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      assert.deepEqual(store.getMemoryEntries(), []);
      assert.deepEqual(store.getUserEntries(), []);
    });

    it("deduplicates entries preserving order", async () => {
      const entry1 = `${TEST_MARKER} dup original`;
      const entry2 = `${TEST_MARKER} dup second`;
      const entry3 = `${TEST_MARKER} dup third`;

      await writeRaw(memoryPath, [entry1, entry2, entry1, entry3].join(ENTRY_DELIMITER));

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entries = store.getMemoryEntries();
      assert.deepEqual(entries, [entry1, entry2, entry3]);
    });
  });

  // ─── formatForSystemPrompt() tests ───

  describe("formatForSystemPrompt()", () => {
    it("returns frozen snapshot — add after load does not change it", async () => {
      await writeRaw(memoryPath, `${TEST_MARKER} original note`);

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const before = store.formatForSystemPrompt();
      assert.ok(before.includes(`${TEST_MARKER} original note`));

      // Add a new entry — this should NOT affect the snapshot
      await store.add("memory", `${TEST_MARKER} new note after load`);

      const after = store.formatForSystemPrompt();
      assert.equal(before, after, "Snapshot should not change after add");
      assert.ok(!after.includes(`${TEST_MARKER} new note after load`));
    });

    it("returns empty string when no entries", async () => {
      // beforeEach cleaned slate — no entries exist
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.equal(result, "");
    });

    it("injects recent failure memories by default", async () => {
      await writeRaw(failurePath, [
        failureEntry(`${TEST_MARKER} failure 1`),
        failureEntry(`${TEST_MARKER} failure 2`),
        failureEntry(`${TEST_MARKER} failure 3`),
        failureEntry(`${TEST_MARKER} failure 4`),
        failureEntry(`${TEST_MARKER} failure 5`),
        failureEntry(`${TEST_MARKER} failure 6`),
      ].join(ENTRY_DELIMITER));

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.ok(result.includes("RECENT FAILURES & LESSONS"));
      assert.ok(result.includes(`${TEST_MARKER} failure 1`));
      assert.ok(result.includes(`${TEST_MARKER} failure 5`));
      assert.ok(!result.includes(`${TEST_MARKER} failure 6`), "default should preserve existing first-5 slice behavior");
    });

    it("does not inject failure memories when disabled", async () => {
      await writeRaw(memoryPath, `${TEST_MARKER} regular memory`);
      await writeRaw(failurePath, failureEntry(`${TEST_MARKER} disabled failure`));

      const store = new MemoryStore(makeConfig({ failureInjectionEnabled: false }));
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.ok(result.includes(`${TEST_MARKER} regular memory`));
      assert.ok(!result.includes("RECENT FAILURES & LESSONS"));
      assert.ok(!result.includes(`${TEST_MARKER} disabled failure`));
    });

    it("respects configured failure injection max entries", async () => {
      await writeRaw(failurePath, [
        failureEntry(`${TEST_MARKER} max entry 1`),
        failureEntry(`${TEST_MARKER} max entry 2`),
        failureEntry(`${TEST_MARKER} max entry 3`),
      ].join(ENTRY_DELIMITER));

      const store = new MemoryStore(makeConfig({ failureInjectionMaxEntries: 2 }));
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.ok(result.includes(`${TEST_MARKER} max entry 1`));
      assert.ok(result.includes(`${TEST_MARKER} max entry 2`));
      assert.ok(!result.includes(`${TEST_MARKER} max entry 3`));
    });

    it("respects configured failure injection max age days", async () => {
      await writeRaw(failurePath, [
        failureEntry(`${TEST_MARKER} recent failure`, 1),
        failureEntry(`${TEST_MARKER} old failure`, 3),
      ].join(ENTRY_DELIMITER));

      const store = new MemoryStore(makeConfig({ failureInjectionMaxAgeDays: 2 }));
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      assert.ok(result.includes(`${TEST_MARKER} recent failure`));
      assert.ok(!result.includes(`${TEST_MARKER} old failure`));
    });

    it("includes both memory and user blocks when both have entries", async () => {
      await writeRaw(memoryPath, `${TEST_MARKER} mem data`);
      await writeRaw(userPath, `${TEST_MARKER} user data`);

      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const result = store.formatForSystemPrompt();
      // Content should be present inside fenced blocks
      assert.ok(result.includes("<memory-context>"), "should use context fencing");
      assert.ok(result.includes("PERSISTENT MEMORY"), "should have guard note");
      assert.ok(result.includes("NOT new user input"), "should disclaim as not user input");
      assert.ok(result.includes("END MEMORY"), "should close fence");
      assert.ok(result.includes("</memory-context>"), "should close XML tag");
      assert.ok(result.includes("MEMORY"), "should contain MEMORY header");
      assert.ok(result.includes("USER PROFILE"), "should contain USER PROFILE header");
      assert.ok(result.includes(`${TEST_MARKER} mem data`));
      assert.ok(result.includes(`${TEST_MARKER} user data`));
    });
  });

  // ─── Atomic writes ───

  describe("atomic writes", () => {
    it("file content is correct after write (read back and check)", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entries = [
        `${TEST_MARKER} first atomic entry`,
        `${TEST_MARKER} second atomic entry`,
      ];

      await store.add("memory", entries[0]);
      await store.add("memory", entries[1]);


      const raw = await readRaw(memoryPath);
      const parsed = raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);

      // Strip metadata comments for comparison (entries now include <!-- created=..., last=... -->)
      const stripped = parsed.map((e) => e.replace(/\s*<!--.*?-->\s*$/, "").trim());
      assert.deepEqual(stripped, entries);
    });

    it("file is empty after all entries are removed", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} temporary entry`);

      let raw = await readRaw(memoryPath);
      assert.ok(raw.length > 0);

      await store.remove("memory", `${TEST_MARKER} temporary entry`);

      raw = await readRaw(memoryPath);
      assert.equal(raw.trim(), "");
    });
  });

  // ─── Both targets ───

  describe("both targets", () => {
    it("add to 'user' goes to USER.md, add to 'memory' goes to MEMORY.md", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("user", `${TEST_MARKER} user fact`);
      await store.add("memory", `${TEST_MARKER} memory fact`);

      const userRaw = await readRaw(userPath);
      const memRaw = await readRaw(memoryPath);

      assert.ok(userRaw.includes(`${TEST_MARKER} user fact`));
      assert.ok(!userRaw.includes(`${TEST_MARKER} memory fact`));
      assert.ok(memRaw.includes(`${TEST_MARKER} memory fact`));
      assert.ok(!memRaw.includes(`${TEST_MARKER} user fact`));
    });
  });

  // ─── Reload-before-write (external mutation visibility) ───
  //
  // Reproduces the stale MemoryStore cache bug: the store caches entries in
  // memory at loadFromDisk() time. If the underlying .md is shrunk externally
  // mid-session (cross-session edit, offline dedup that rewrote the .md, a
  // regenerated file) the in-memory charCount goes stale and a subsequent add
  // is wrongly rejected with the OLD count. The fix reloads from disk before
  // the capacity check, so charCount reflects on-disk state at write time.
  describe("reload-before-write (external mutation visibility)", () => {
    it("add() succeeds after the .md is externally shrunk mid-session (no stale-count reject)", async () => {
      // Pick a limit where `big` fits alone, but `big` + `fresh` would exceed —
      // so before the shrink the add would be rejected, after the shrink it fits.
      const limit = 200;
      const store = new MemoryStore(makeConfig({ memoryCharLimit: limit }));
      await store.loadFromDisk();

      const big = `${TEST_MARKER} ${"x".repeat(100)}`;
      assert.ok((await store.add("memory", big)).success, "big entry should fit initially");

      // EXTERNALLY shrink the file (simulate cross-session removal / dedup that
      // rewrote the .md). This does NOT refresh the in-memory cache.
      await writeRaw(memoryPath, "");

      // The cache is still stale (reflects pre-shrink content) — proves the
      // external edit did not auto-refresh the store.
      assert.ok(store.charCount("memory") > 0, "in-memory cache should be stale (still reflects pre-shrink content)");

      // A new entry that could NOT have fit before the shrink but CAN after.
      const fresh = `${TEST_MARKER} fresh after external shrink`;
      const result = await store.add("memory", fresh);

      assert.ok(result.success, `Expected add to succeed after external shrink, but got: ${result.error}`);

      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(fresh), "fresh entry should be persisted");
      assert.ok(!raw.includes(big), "externally-removed entry should stay gone");
    });

    it("charCount reflects on-disk state at write time, not the startup snapshot", async () => {
      const store = new MemoryStore(makeConfig({ memoryCharLimit: 500 }));
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} alpha`);
      const countAfterFirstLoad = store.charCount("memory");
      assert.ok(countAfterFirstLoad > 0);

      // Externally rewrite the file with different content.
      await writeRaw(memoryPath, `${TEST_MARKER} externally rewritten`);

      // Trigger an op whose reload-path refreshes in-memory state (replace
      // reloads at its top even though the lookup below won't match).
      await store.replace("memory", "nonexistent-marker-xyz", `${TEST_MARKER} nope`).catch(() => {});

      const memEntries = store.getMemoryEntries();
      assert.ok(
        memEntries.some((e) => e.includes("externally rewritten")),
        `entries/charCount should reflect the external rewrite; got: ${JSON.stringify(memEntries)}`,
      );
      assert.notEqual(store.charCount("memory"), countAfterFirstLoad);
    });

    it("replace() sees an externally-added entry mid-session", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      // Externally add an entry the store does not yet know about.
      await writeRaw(memoryPath, `${TEST_MARKER} externally added line`);

      // Without reload, replace could not match it (stale empty cache).
      const result = await store.replace("memory", "externally added line", `${TEST_MARKER} externally replaced line`);

      assert.ok(result.success, `Expected replace to see the externally-added entry, but got: ${result.error}`);
      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes("externally replaced line"));
      assert.ok(!raw.includes("externally added line"));
    });

    it("concurrent same-session adds do not lose data (reload does not clobber in-flight writes)", async () => {
      // The reload-before-write fix must not break concurrent writes in the same
      // session: two adds issued without awaiting must both land. Guards the
      // "reload must not clobber a concurrent in-flight write" edge case.
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const [a, b] = await Promise.all([
        store.add("memory", `${TEST_MARKER} concurrent A`),
        store.add("memory", `${TEST_MARKER} concurrent B`),
      ]);

      assert.ok(a.success, `concurrent A failed: ${a.error}`);
      assert.ok(b.success, `concurrent B failed: ${b.error}`);

      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(`${TEST_MARKER} concurrent A`), "concurrent A should persist");
      assert.ok(raw.includes(`${TEST_MARKER} concurrent B`), "concurrent B should persist");
    });
  });

  describe("cross-process file lock (withFileLock)", () => {
    /** True iff a lock directory exists for the given source file. */
    async function lockExists(srcPath: string): Promise<boolean> {
      try { await fs.stat(`${srcPath}.lock`); return true; } catch { return false; }
    }

    it("acquires the lock during a write, then releases it (no leftover .lock dir)", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      assert.equal(await lockExists(memoryPath), false, "no lock before write");
      assert.ok((await store.add("memory", `${TEST_MARKER} lock-release`)).success);
      assert.equal(await lockExists(memoryPath), false, "lock released after write");
      assert.ok((await readRaw(memoryPath)).includes("lock-release"));
    });

    it("PI_MEMORY_FILE_LOCK=bypass skips the cross-process lock (consolidator child path)", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();
      const prev = process.env.PI_MEMORY_FILE_LOCK;
      process.env.PI_MEMORY_FILE_LOCK = "bypass";
      try {
        assert.ok((await store.add("memory", `${TEST_MARKER} bypass-no-lock`)).success);
        assert.equal(await lockExists(memoryPath), false, "bypass must not create a lock dir");
      } finally {
        if (prev === undefined) delete process.env.PI_MEMORY_FILE_LOCK;
        else process.env.PI_MEMORY_FILE_LOCK = prev;
      }
      assert.ok((await readRaw(memoryPath)).includes("bypass-no-lock"));
    });

    it("serializes concurrent writes from two store instances on the same .md (no lost update)", async () => {
      // THE core cross-process guarantee: two store instances (simulating two
      // sessions) writing the same .md concurrently must BOTH land. Without
      // withFileLock, loadFromDisk→saveToDisk races → last-writer-wins → one is
      // lost. With the lock, instance B blocks on the lockfile until A releases,
      // then reloads (seeing A's entry) and appends.
      const storeA = new MemoryStore(makeConfig());
      const storeB = new MemoryStore(makeConfig());
      await storeA.loadFromDisk();
      await storeB.loadFromDisk();

      const [a, b] = await Promise.all([
        storeA.add("memory", `${TEST_MARKER} cross-instance A`),
        storeB.add("memory", `${TEST_MARKER} cross-instance B`),
      ]);
      assert.ok(a.success, `A failed: ${a.error}`);
      assert.ok(b.success, `B failed: ${b.error}`);

      await storeA.loadFromDisk();
      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes("cross-instance A"), "A's entry must persist (no lost update)");
      assert.ok(raw.includes("cross-instance B"), "B's entry must persist (no lost update)");
    });

    it("runConsolidator sets PI_MEMORY_FILE_LOCK=bypass for the child, then restores it", async () => {
      const store = new MemoryStore(makeConfig({
        memoryCharLimit: 200,
        memoryOverflowStrategy: "auto-consolidate",
        autoConsolidate: true,
      }));
      let envDuringConsolidation: string | undefined = "<not called>";
      store.setConsolidator(async () => {
        envDuringConsolidation = process.env.PI_MEMORY_FILE_LOCK;
        return { consolidated: false }; // frees nothing → floor to vault-offload
      });
      await store.loadFromDisk();
      const prev = process.env.PI_MEMORY_FILE_LOCK;

      await store.add("memory", `${TEST_MARKER} consolidate env 1`);
      await store.add("memory", `${TEST_MARKER} consolidate env 2`);
      // third overflows → auto-consolidate → runConsolidator wraps the child spawn
      const result = await store.add("memory", `${TEST_MARKER} consolidate env 3`);

      assert.equal(envDuringConsolidation, "bypass",
        `consolidator child must inherit bypass env; got ${envDuringConsolidation}`);
      assert.equal(process.env.PI_MEMORY_FILE_LOCK, prev, "env restored after consolidation");
      assert.ok(result.success, `floor should still save (never-reject): ${result.error}`);
    });
  });
});
