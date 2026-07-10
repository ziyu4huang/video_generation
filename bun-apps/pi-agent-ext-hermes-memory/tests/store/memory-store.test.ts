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

  /** Wait for fire-and-forget atomic write to settle. */
  async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 200));
  }

  /** Aggressively clean both memory files and wait for pending writes. */
  async function cleanSlate(): Promise<void> {
    await removeFile(memoryPath);
    await removeFile(userPath);
    await removeFile(failurePath);
    await new Promise((r) => setTimeout(r, 250));
    // Remove again in case a pending write sneaked in during the wait
    await removeFile(memoryPath);
    await removeFile(userPath);
    await removeFile(failurePath);
    await new Promise((r) => setTimeout(r, 50));
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
      await settle();

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
      await settle();

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
      await settle();

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
      await settle();

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
      await settle();

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
      await settle();

      assert.ok(!result.success);
      assert.ok(result.error!.includes("exceed the limit"));
      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(existing));
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
      await settle();

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
      await settle();

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
      await settle();

      assert.ok(result.success);
      assert.equal(result.entry_count, 1);
    });

    it("handles unicode content", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const entry = `${TEST_MARKER} 日本語テスト 🧪`;
      const result = await await store.add("memory", entry);
      await settle();

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
      await settle();

      assert.ok(result.success, `Expected success but got error: ${result.error}`);
    });

    it("handles sequential adds (two in sequence)", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      const r1 = await store.add("memory", `${TEST_MARKER} first entry`);
      assert.ok(r1.success, `First add failed: ${r1.error}`);
      await settle();

      const r2 = await store.add("memory", `${TEST_MARKER} second entry`);
      assert.ok(r2.success, `Second add failed: ${r2.error}`);
      await settle();

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
      await settle();

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
      await settle();

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
      await settle();

      const result = await store.replace("memory", `${TEST_MARKER} uses vim`, `${TEST_MARKER} uses neovim`);
      await settle();

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
      await settle();

      const result = await store.replace("memory", "nonexistent substring", "new content");
      await settle();

      assert.ok(!result.success);
      assert.ok(result.error!.includes("No entry matched"));
    });

    it("returns error for multiple matches", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} config: port=8080`);
      await store.add("memory", `${TEST_MARKER} config: port=9090`);
      await settle();

      const result = await store.replace("memory", "config:", `${TEST_MARKER} unified config`);
      await settle();

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
  });

  // ─── remove() tests ───

  describe("remove()", () => {
    it("removes entry from file", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} to be removed`);
      await store.add("memory", `${TEST_MARKER} to keep`);
      await settle();

      const result = await store.remove("memory", `${TEST_MARKER} to be removed`);
      await settle();

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
      await settle();

      const result = await store.remove("memory", `🧠 [global] ${TEST_MARKER} prefers pnpm over npm\n   Created: 2026-05-27 | Last used: 2026-05-27`);
      await settle();

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
      await settle();

      const result = await store.remove(
        "failure",
        `⚠️ [global] [correction] [correction] ${TEST_MARKER} use pnpm\n   Created: 2026-05-27 | Last used: 2026-05-27`,
      );
      await settle();

      assert.ok(result.success);
      const raw = await readRaw(failurePath);
      assert.equal(raw.trim(), "");
    });

    it("returns error when no match found", async () => {
      const store = new MemoryStore(makeConfig());
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} existing`);
      await settle();

      const result = await store.remove("memory", "nonexistent");
      await settle();

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
      await settle();
      await store.add("memory", entries[1]);
      await settle();


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
      await settle();

      let raw = await readRaw(memoryPath);
      assert.ok(raw.length > 0);

      await store.remove("memory", `${TEST_MARKER} temporary entry`);
      await settle();

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
      await settle();

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
      await settle();

      // EXTERNALLY shrink the file (simulate cross-session removal / dedup that
      // rewrote the .md). This does NOT refresh the in-memory cache.
      await writeRaw(memoryPath, "");
      await settle();

      // The cache is still stale (reflects pre-shrink content) — proves the
      // external edit did not auto-refresh the store.
      assert.ok(store.charCount("memory") > 0, "in-memory cache should be stale (still reflects pre-shrink content)");

      // A new entry that could NOT have fit before the shrink but CAN after.
      const fresh = `${TEST_MARKER} fresh after external shrink`;
      const result = await store.add("memory", fresh);
      await settle();

      assert.ok(result.success, `Expected add to succeed after external shrink, but got: ${result.error}`);

      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(fresh), "fresh entry should be persisted");
      assert.ok(!raw.includes(big), "externally-removed entry should stay gone");
    });

    it("charCount reflects on-disk state at write time, not the startup snapshot", async () => {
      const store = new MemoryStore(makeConfig({ memoryCharLimit: 500 }));
      await store.loadFromDisk();

      await store.add("memory", `${TEST_MARKER} alpha`);
      await settle();
      const countAfterFirstLoad = store.charCount("memory");
      assert.ok(countAfterFirstLoad > 0);

      // Externally rewrite the file with different content.
      await writeRaw(memoryPath, `${TEST_MARKER} externally rewritten`);
      await settle();

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
      await settle();

      // Without reload, replace could not match it (stale empty cache).
      const result = await store.replace("memory", "externally added line", `${TEST_MARKER} externally replaced line`);
      await settle();

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
      await settle();

      assert.ok(a.success, `concurrent A failed: ${a.error}`);
      assert.ok(b.success, `concurrent B failed: ${b.error}`);

      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(`${TEST_MARKER} concurrent A`), "concurrent A should persist");
      assert.ok(raw.includes(`${TEST_MARKER} concurrent B`), "concurrent B should persist");
    });

    it("add() succeeds after direct SQL deletes from sessions.db (opt-in DB reconciliation)", async () => {
      // Demonstrates the SQL-dedup branch of criterion 1: the .md is the capacity
      // source and is untouched by direct SQL deletes from sessions.db. With
      // opt-in reconcileMarkdownFromDb, loadFromDisk prunes .md entries whose
      // content was removed from the DB (archived, so reversible), freeing
      // capacity so add succeeds in the same session.
      const { DatabaseManager } = await import("../../src/store/db.js");
      const { syncMemoryEntry } = await import("../../src/store/sqlite-memory-store.js");
      const dbManager = new DatabaseManager(MEMORY_DIR);
      // Start from a clean DB slice so prior runs don't perturb reconciliation.
      dbManager.getDb().prepare("DELETE FROM memories").run();

      const limit = 260;
      const store = new MemoryStore(makeConfig({ memoryCharLimit: limit, reconcileMarkdownFromDb: true }));
      store.setDatabaseManager(dbManager, null);
      await store.loadFromDisk();

      // Seed BOTH the .md (via store) and the DB (via syncMemoryEntry) with
      // identical content — mirrors the real tool path so the two stores match.
      const seed = async (text: string) => {
        assert.ok((await store.add("memory", text)).success, `seed add failed: ${text}`);
        syncMemoryEntry(dbManager, { content: text, target: "memory", project: null });
      };
      await seed(`${TEST_MARKER} reconcile keep me`);
      await seed(`${TEST_MARKER} reconcile dup one`);
      await seed(`${TEST_MARKER} reconcile dup two`);
      await settle();

      // Sanity: the .md is full enough that a fresh entry is rejected (the old
      // behavior the bug report complained about).
      const fresh = `${TEST_MARKER} fresh after sql dedup`;
      const blocked = await store.add("memory", fresh);
      assert.ok(!blocked.success, "fresh add should be rejected while dedup'd entries still occupy the .md");

      // Offline bulk-dedup: delete two rows directly from sessions.db.
      const db = dbManager.getDb();
      db.prepare("DELETE FROM memories WHERE content LIKE ?").run("%reconcile dup%");
      await settle();

      // Now add succeeds: reload reconciles the .md against the post-dedup DB
      // (prunes the two deleted entries, archived), freeing capacity.
      const result = await store.add("memory", fresh);
      assert.ok(result.success, `add should succeed after SQL dedup + reconciliation: ${result.error}`);

      const raw = await readRaw(memoryPath);
      assert.ok(raw.includes(fresh), "fresh entry should be persisted");
      assert.ok(raw.includes("reconcile keep me"), "non-deleted entry should remain");
      assert.ok(!raw.includes("reconcile dup one"), "SQL-deleted entry should be pruned from .md");
      assert.ok(!raw.includes("reconcile dup two"), "SQL-deleted entry should be pruned from .md");

      dbManager.close();
    });
  });
});
