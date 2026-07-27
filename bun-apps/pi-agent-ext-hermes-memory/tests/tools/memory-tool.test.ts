/**
 * Unit tests for memory tool registration and execute function.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerMemoryTool, writeTransferArchive } from "../../src/tools/memory-tool.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "../../src/store/sqlite/sqlite-memory-repo.js";
import type { MemoryRepository } from "../../src/store/repository.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

describe("registerMemoryTool", () => {
  let tmpDir: string;
  let backend: SqliteBackend;
  let memoryRepo: SqliteMemoryRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-tool-test-"));
    backend = new SqliteBackend(tmpDir);
    memoryRepo = new SqliteMemoryRepository(backend);
  });

  it("registerMemoryTool returns the memory ToolDefinition for bridging", () => {
    const registeredTools: any[] = [];

    const mockPi = {
      registerTool: (def: any) => {
        registeredTools.push(def);
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      add: () => ({ success: true, target: "memory", entries: ["test"], usage: "10% — 10/100 chars", entry_count: 1 }),
      replace: () => ({ success: true, target: "memory", entries: [], usage: "0% — 0/100 chars", entry_count: 0 }),
      remove: () => ({ success: true, target: "memory", entries: [], usage: "0% — 0/100 chars", entry_count: 0 }),
    } as unknown as MemoryStore;

    const def = registerMemoryTool(mockPi, mockStore, null);
    assert.ok(def, "registerMemoryTool must return the ToolDefinition");
    assert.equal(def.name, "memory");
    assert.equal(typeof def.execute, "function");
    // sanity: it is the same shape the host received
    assert.equal(registeredTools[0]?.name, "memory");
  });

  afterEach(async () => {
    await backend.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers tool with name 'memory' and correct parameters", () => {
    const registeredTools: any[] = [];

    const mockPi = {
      registerTool: (def: any) => {
        registeredTools.push(def);
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      add: () => ({ success: true, target: "memory", entries: ["test"], usage: "10% — 10/100 chars", entry_count: 1 }),
      replace: () => ({ success: true, target: "memory", entries: [], usage: "0% — 0/100 chars", entry_count: 0 }),
      remove: () => ({ success: true, target: "memory", entries: [], usage: "0% — 0/100 chars", entry_count: 0 }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);

    assert.strictEqual(registeredTools.length, 1, "should register exactly one tool");
    const tool = registeredTools[0];
    assert.strictEqual(tool.name, "memory", "tool name should be 'memory'");
    assert.strictEqual(tool.label, "Memory", "tool label should be 'Memory'");
    assert.ok(tool.description.length > 0, "description should not be empty");
    // promptSnippet/promptGuidelines removed (stealth — description routes; system-prompt saving)
    assert.equal(tool.promptSnippet, undefined);
    assert.equal(tool.promptGuidelines, undefined);
    assert.ok(tool.parameters, "parameters schema should be defined");
  });

  it("execute add returns usage in structured details", async () => {
    let capturedResult: any;

    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["Entry one"],
        usage: "5% — 110/5000 chars",
        entry_count: 1,
        message: "Entry added.",
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, memoryRepo);
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "Entry one" }, undefined as any, undefined as any, undefined as any);

    assert.strictEqual(result.content[0].type, "text", "content should be text type");
    const parsed = result.details;
    assert.strictEqual(parsed.success, true, "result should be success");
    assert.ok(parsed.usage.includes("chars"), "usage should contain 'chars'");
    assert.ok(parsed.usage.includes("5000"), "usage should show total limit");
    assert.strictEqual(parsed.entry_count, 1, "entry_count should be 1");
  });

  it("execute add renders a human-readable one-line summary (not raw JSON)", async () => {
    let capturedResult: any;
    const mockPi = { registerTool: (def: any) => { capturedResult = def; } } as unknown as ExtensionAPI;
    const mockStore = {
      add: () => ({
        success: true, target: "memory", entries: ["Entry one"],
        usage: "5% — 110/5000 chars", entry_count: 1, message: "Entry added.",
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, memoryRepo);
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "Entry one" }, undefined as any, undefined as any, undefined as any);

    const text = result.content[0].text;
    assert.throws(() => JSON.parse(text), "text must no longer be raw JSON");
    assert.match(text, /^✓ Entry added/);
    assert.match(text, /1 entry/);
    assert.match(text, /5% — 110\/5000 chars/);
  });

  it("execute add failure renders a human-readable error line (not raw JSON)", async () => {
    let capturedResult: any;
    const mockPi = { registerTool: (def: any) => { capturedResult = def; } } as unknown as ExtensionAPI;
    const mockStore = {
      add: () => ({ success: false, error: "Memory at 5000/5000 chars. Adding would exceed the limit." }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "x" }, undefined as any, undefined as any, undefined as any);

    const text = result.content[0].text;
    assert.throws(() => JSON.parse(text), "failure text must no longer be raw JSON");
    assert.match(text, /^✗/);
    assert.ok(text.includes("exceed the limit"), "error detail surfaces in text");
    assert.strictEqual(result.details.success, false);
    assert.match(result.details.error ?? "", /exceed the limit/);
  });

  it("execute add with FIFO evictions returns normal text with full rotated entries", async () => {
    let capturedResult: any;

    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const evictedOne = "First rotated entry with full detail.";
    const evictedTwo = "Second rotated entry with\nmultiple lines preserved.";
    const mockStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["New entry"],
        usage: "90% — 4500/5000 chars",
        entry_count: 1,
        message: "Memory updated. Rotated 2 older entries to stay within the limit.",
        evicted_entries: [evictedOne, evictedTwo],
        evicted_count: 2,
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "New entry" }, undefined as any, undefined as any, undefined as any);

    const text = result.content[0].text;
    assert.throws(() => JSON.parse(text));
    assert.match(text, /Memory updated\. Rotated 2 older entries/);
    assert.match(text, /Rotated active memory entries:/);
    assert.ok(text.includes(`1. ${evictedOne}`));
    assert.ok(text.includes(`2. ${evictedTwo}`));
    assert.match(text, /If one of these entries should stay active, add it again\./);
    assert.match(text, /Usage: 90%/);
    assert.deepStrictEqual(result.details.evicted_entries, [evictedOne, evictedTwo]);
  });

  it("syncs successful adds into SQLite", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["Entry one"],
        usage: "5% — 110/5000 chars",
        entry_count: 1,
        message: "Entry added.",
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, memoryRepo);
    await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "Entry one" }, undefined as any, undefined as any, undefined as any);

    const results = await memoryRepo.getMemories({ target: 'memory', project: null });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].content, 'Entry one');
  });

  it("removes FIFO-evicted entries from the SQLite mirror", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    await memoryRepo.syncMemoryEntry({
      content: "Older entry",
      target: "memory",
      project: null,
    });
    await memoryRepo.syncMemoryEntry({
      content: "Older entry with extra detail",
      target: "memory",
      project: null,
    });

    const mockStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["New entry"],
        usage: "90% — 4500/5000 chars",
        entry_count: 1,
        message: "Memory updated. Rotated 1 older entry to stay within the limit.",
        evicted_entries: ["Older entry"],
        evicted_count: 1,
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, memoryRepo);
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "New entry" }, undefined as any, undefined as any, undefined as any);

    assert.match(result.content[0].text, /Rotated active memory entries:/);
    const rows = await memoryRepo.getMemories({ target: "memory", project: null });
    assert.deepStrictEqual(rows.map((row) => row.content).sort(), ["New entry", "Older entry with extra detail"].sort());
  });

  it("uses project scope when removing FIFO-evicted SQLite entries", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    await memoryRepo.syncMemoryEntry({
      content: "Shared wording",
      target: "memory",
      project: null,
    });
    await memoryRepo.syncMemoryEntry({
      content: "Shared wording",
      target: "memory",
      project: "project-a",
    });

    const mockProjectStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["Project replacement"],
        usage: "90% — 4500/5000 chars",
        entry_count: 1,
        message: "Memory updated. Rotated 1 older entry to stay within the limit.",
        evicted_entries: ["Shared wording"],
        evicted_count: 1,
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, {} as MemoryStore, mockProjectStore, memoryRepo, "project-a");
    await capturedResult.execute("tc-1", { action: "add", target: "project", content: "Project replacement" }, undefined as any, undefined as any, undefined as any);

    const globalRows = await memoryRepo.getMemories({ target: "memory", project: null });
    const projectRows = await memoryRepo.getMemories({ target: "memory", project: "project-a" });
    assert.deepStrictEqual(globalRows.map((row) => row.content), ["Shared wording"]);
    assert.deepStrictEqual(projectRows.map((row) => row.content), ["Project replacement"]);
  });

  it("maps project target to SQLite project scope", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const addTargets: string[] = [];
    const mockProjectStore = {
      add: (target: string) => {
        addTargets.push(target);
        return {
          success: true,
          target,
          entries: ["Project entry"],
          usage: "2% — 20/5000 chars",
          entry_count: 1,
          message: "Entry added.",
        };
      },
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, {} as MemoryStore, mockProjectStore, memoryRepo, 'project-a');
    const result = await capturedResult.execute("tc-1", { action: "add", target: "project", content: "Project entry" }, undefined as any, undefined as any, undefined as any);

    const parsed = result.details;
    assert.strictEqual(parsed.target, 'project');
    assert.strictEqual(result.details.target, 'project');
    assert.deepStrictEqual(addTargets, ['memory']);

    const results = await memoryRepo.getMemories({ project: 'project-a', target: 'memory' });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].content, 'Project entry');
  });

  it("returns a warning instead of failing when SQLite sync errors", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["Entry one"],
        usage: "5% — 110/5000 chars",
        entry_count: 1,
        message: "Entry added.",
      }),
    } as unknown as MemoryStore;

    const failingMemoryRepo = {
      syncMemoryEntry: async () => { throw new Error('sqlite unavailable'); },
    } as unknown as MemoryRepository;

    registerMemoryTool(mockPi, mockStore, null, failingMemoryRepo);
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "Entry one" }, undefined as any, undefined as any, undefined as any);

    const parsed = result.details;
    assert.strictEqual(parsed.success, true);
    assert.match(parsed.message, /search store sync failed/);
    assert.match(parsed.warning, /sqlite unavailable/);
  });

  it("does not warn when repo sync succeeds (retry is now internal to the repo)", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => { capturedResult = def; },
    } as unknown as ExtensionAPI;
    const mockStore = {
      add: () => ({
        success: true, target: "memory", entries: ["Entry one"],
        usage: "5% — 110/5000 chars", entry_count: 1, message: "Entry added.",
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, memoryRepo);
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "Entry one" }, undefined as any, undefined as any, undefined as any);
    const parsed = result.details;

    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.warning, undefined, "no sync-warning when repo succeeds");
    const rows = await memoryRepo.getMemories({ target: "memory", project: null });
    assert.strictEqual(rows.length, 1, "entry synced to SQLite");
  });

  it("still warns when a transient SQLite error persists across retries", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => { capturedResult = def; },
    } as unknown as ExtensionAPI;
    const mockStore = {
      add: () => ({
        success: true, target: "memory", entries: ["Entry two"],
        usage: "5% — 110/5000 chars", entry_count: 1, message: "Entry added.",
      }),
    } as unknown as MemoryStore;

    const persistentFlaky = {
      syncMemoryEntry: async () => { throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" }); },
    } as unknown as MemoryRepository;

    registerMemoryTool(mockPi, mockStore, null, persistentFlaky);
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "Entry two" }, undefined as any, undefined as any, undefined as any);
    const parsed = result.details;

    assert.strictEqual(parsed.success, true);
    assert.match(parsed.message, /search store sync failed/);
    assert.match(parsed.warning, /disk I\/O error/);
  });

  it("does not sync to SQLite when core Markdown add fails", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      add: () => ({
        success: false,
        error: "Memory at 5000/5000 chars. Adding this entry would exceed the limit.",
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, memoryRepo);
    const result = await capturedResult.execute(
      "tc-1",
      { action: "add", target: "memory", content: "overflow entry" },
      undefined as any,
      undefined as any,
      undefined as any,
    );

    const parsed = result.details;
    assert.strictEqual(parsed.success, false);

    const rows = await memoryRepo.getMemories({ target: "memory", project: null });
    assert.strictEqual(rows.length, 0, "SQLite should stay unchanged when core add fails");
  });

  it("execute add without content returns error", async () => {
    let capturedResult: any;

    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {} as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory" }, undefined as any, undefined as any, undefined as any);

    const parsed = result.details;
    assert.strictEqual(parsed.success, false, "should fail without content");
    assert.ok(parsed.error.includes("required"), "error should mention required content");
  });

  it("execute replace without old_text returns error", async () => {
    let capturedResult: any;

    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {} as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    const result = await capturedResult.execute("tc-1", { action: "replace", target: "memory", content: "new" }, undefined as any, undefined as any, undefined as any);

    const parsed = result.details;
    assert.strictEqual(parsed.success, false, "should fail without old_text");
    assert.ok(parsed.error.includes("old_text"), "error should mention old_text");
  });

  it("execute remove without old_text returns error", async () => {
    let capturedResult: any;

    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {} as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    const result = await capturedResult.execute("tc-1", { action: "remove", target: "memory" }, undefined as any, undefined as any, undefined as any);

    const parsed = result.details;
    assert.strictEqual(parsed.success, false, "should fail without old_text");
    assert.ok(parsed.error.includes("old_text"), "error should mention old_text");
  });

  it("execute delegates replace to store.replace", async () => {
    let capturedResult: any;
    let replaceArgs: any;

    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      replace: (...args: any[]) => {
        replaceArgs = args;
        return { success: true, target: "memory", entries: ["new"], usage: "5% — 110/5000 chars", entry_count: 1 };
      },
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    await capturedResult.execute("tc-1", { action: "replace", target: "memory", content: "new", old_text: "old" }, undefined as any, undefined as any, undefined as any);

    assert.deepStrictEqual(replaceArgs, ["memory", "old", "new"], "should pass target, old_text, content to store.replace");
  });

  it("execute delegates remove to store.remove", async () => {
    let capturedResult: any;
    let removeArgs: any;

    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const mockStore = {
      remove: (...args: any[]) => {
        removeArgs = args;
        return { success: true, target: "memory", entries: [], usage: "0% — 0/5000 chars", entry_count: 0 };
      },
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null);
    await capturedResult.execute("tc-1", { action: "remove", target: "memory", old_text: "old entry" }, undefined as any, undefined as any, undefined as any);

    assert.deepStrictEqual(removeArgs, ["memory", "old entry"], "should pass target, old_text to store.remove");
  });

  it("writeTransferArchive: two same-second calls produce distinct, non-overwriting files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-archive-test-"));
    try {
      const p1 = writeTransferArchive("memory", ["entry A content"], dir);
      const p2 = writeTransferArchive("memory", ["entry B content"], dir);
      assert.notStrictEqual(p1, p2, "two same-second calls must not collide on filename");
      assert.ok(fs.existsSync(p1), "first archive must still exist (not overwritten)");
      assert.ok(fs.existsSync(p2), "second archive must exist");
      assert.ok(fs.readFileSync(p1, "utf-8").includes("entry A content"), "first archive keeps its own content");
      assert.ok(fs.readFileSync(p2, "utf-8").includes("entry B content"), "second archive keeps its own content");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('memory-tool user-facing strings contain no hardcoded backend token', () => {
    const src = fs.readFileSync(
      path.join(import.meta.dir, '..', '..', 'src', 'tools', 'memory-tool.ts'),
      'utf-8',
    );
    // Matches sqlite/surrealdb only INSIDE string literals (quoted), ignoring
    // identifiers (e.g. syncAddToSqlite) and comments.
    const backendInLiteral = /['"`][^'"`\n]*(sqlite|surrealdb)[^'"`\n]*['"`]/i;
    assert.ok(
      !backendInLiteral.test(src),
      'memory-tool.ts must not hardcode a backend name inside any string literal',
    );
  });
});
