/**
 * Unit tests for memory tool registration and execute function.
 */
import { describe, it, beforeEach, afterEach } from "bun:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerMemoryTool, writeTransferArchive } from "../../src/tools/memory-tool.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "../../src/store/sqlite/sqlite-memory-repo.js";
import { createCardStore } from "../../src/store/card-store.js";
import { MemorySerializer } from "../../src/store/memory-serializer.js";
import type { CardStore } from "../../src/store/card-store.js";
import type { MemoryRepository } from "../../src/store/repository.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

describe("registerMemoryTool", () => {
  let tmpDir: string;
  let backend: SqliteBackend;
  let memoryRepo: SqliteMemoryRepository;
  let cardStore: CardStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-tool-test-"));
    backend = new SqliteBackend(tmpDir);
    memoryRepo = new SqliteMemoryRepository(backend);
  });

  /** Real card store joined on the shared test backend (bundle-join style).
   *  Deferred to per-test setup so tests that don't need a mirror skip it. */
  async function makeCardStore(): Promise<CardStore> {
    cardStore = await createCardStore({ memoryDir: tmpDir, sqliteBackend: backend });
    return cardStore;
  }

  /** Fake card store whose upsertCard throws — the mirror-error seam. */
  function failingCardStore(message = "sqlite unavailable"): CardStore {
    return {
      serializerFor: (kind: any) => new MemorySerializer(kind),
      upsertCard: async () => { throw new Error(message); },
      getCardsByKind: async () => [],
    } as unknown as CardStore;
  }

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
    if (cardStore) await cardStore.close();
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

    registerMemoryTool(mockPi, mockStore, null);
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

    registerMemoryTool(mockPi, mockStore, null);
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

  it("mirrors successful adds into the card store (md_id-keyed)", async () => {
    let capturedResult: any;
    const mockPi = {
      registerTool: (def: any) => {
        capturedResult = def;
      },
    } as unknown as ExtensionAPI;

    const ADDED_MD_ID = "md-add-tool-1111";
    const mockStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["Entry one"],
        usage: "5% — 110/5000 chars",
        entry_count: 1,
        message: "Entry added.",
        added_md_id: ADDED_MD_ID,
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, null, await makeCardStore());
    await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "Entry one" }, undefined as any, undefined as any, undefined as any);

    const cards = await cardStore.getCardsByKind("memory");
    assert.strictEqual(cards.length, 1, "add mirrors one card");
    assert.strictEqual(cards[0].content, "Entry one");
    assert.strictEqual(cards[0].id, ADDED_MD_ID, "card id == the .md frontmatter id");
    // The card row lands in the SAME memories table → still searchable.
    const results = await memoryRepo.getMemories({ target: 'memory', project: null });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].content, 'Entry one');
    assert.strictEqual(results[0].mdId, ADDED_MD_ID);
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
    // Steady-state DB-sync keys on md_id (ticket 04): mirror an md_id onto the
    // row that will be evicted so removeByMdId can match it.
    const OLDER_MD_ID = "older-11111111-2222-3333-4444-555566667777";
    await memoryRepo.setMdIdByContent("Older entry", OLDER_MD_ID, { target: "memory", project: null });

    const NEW_MD_ID = "md-new-tool-2222";
    const mockStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["New entry"],
        usage: "90% — 4500/5000 chars",
        entry_count: 1,
        message: "Memory updated. Rotated 1 older entry to stay within the limit.",
        evicted_entries: ["Older entry"],
        evicted_md_ids: [OLDER_MD_ID],
        evicted_count: 1,
        added_md_id: NEW_MD_ID,
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, null, await makeCardStore());
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "New entry" }, undefined as any, undefined as any, undefined as any);

    assert.match(result.content[0].text, /Rotated active memory entries:/);
    const rows = await memoryRepo.getMemories({ target: "memory", project: null });
    assert.deepStrictEqual(rows.map((row) => row.content).sort(), ["New entry", "Older entry with extra detail"].sort());
    // The new entry arrives via the card-store mirror (md_id-keyed).
    const cards = await cardStore.getCardsByKind("memory");
    assert.deepStrictEqual(cards.map((c) => c.id), [NEW_MD_ID]);
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
    // Steady-state DB-sync keys on md_id (ticket 04). Only the PROJECT-scoped
    // row carries the evicted md_id, so removeByMdId(project scope) deletes
    // only it — the identically-worded global row survives (scope isolation).
    const PROJECT_MD_ID = "project-22222222-3333-4444-5555-666677778888";
    await memoryRepo.setMdIdByContent("Shared wording", PROJECT_MD_ID, { target: "memory", project: "project-a" });

    const PROJECT_NEW_MD_ID = "md-project-new-3333";
    const mockProjectStore = {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["Project replacement"],
        usage: "90% — 4500/5000 chars",
        entry_count: 1,
        message: "Memory updated. Rotated 1 older entry to stay within the limit.",
        evicted_entries: ["Shared wording"],
        evicted_md_ids: [PROJECT_MD_ID],
        evicted_count: 1,
        added_md_id: PROJECT_NEW_MD_ID,
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, {} as MemoryStore, mockProjectStore, "project-a", await makeCardStore());
    await capturedResult.execute("tc-1", { action: "add", target: "project", content: "Project replacement" }, undefined as any, undefined as any, undefined as any);

    const globalRows = await memoryRepo.getMemories({ target: "memory", project: null });
    const projectRows = await memoryRepo.getMemories({ target: "memory", project: "project-a" });
    // The mirrored card row is project-agnostic (project NULL), so the global
    // scope sees it alongside the untouched identically-worded global seed.
    assert.deepStrictEqual(globalRows.map((row) => row.content).sort(), ["Project replacement", "Shared wording"].sort());
    assert.deepStrictEqual(projectRows.map((row) => row.content), [], "evicted project row removed (removeByMdId path)");
    // The project replacement mirrors as a kind:"memory" card (project-agnostic envelope).
    const cards = await cardStore.getCardsByKind("memory");
    assert.deepStrictEqual(cards.map((c) => c.content), ["Project replacement"]);
    assert.deepStrictEqual(cards.map((c) => c.id), [PROJECT_NEW_MD_ID]);
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
          added_md_id: "md-project-scope-4444",
        };
      },
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, {} as MemoryStore, mockProjectStore, 'project-a', await makeCardStore());
    const result = await capturedResult.execute("tc-1", { action: "add", target: "project", content: "Project entry" }, undefined as any, undefined as any, undefined as any);

    const parsed = result.details;
    assert.strictEqual(parsed.target, 'project');
    assert.strictEqual(result.details.target, 'project');
    assert.deepStrictEqual(addTargets, ['memory']);

    // The project add mirrors as a kind:"memory" card (project-agnostic envelope).
    const cards = await cardStore.getCardsByKind("memory");
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0].content, 'Project entry');
  });

  it("returns a warning instead of failing when the card-store mirror errors", async () => {
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
        added_md_id: "md-warn-7777",
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, null, failingCardStore());
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
        added_md_id: "md-nowarn-5555",
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, null, await makeCardStore());
    const result = await capturedResult.execute("tc-1", { action: "add", target: "memory", content: "Entry one" }, undefined as any, undefined as any, undefined as any);
    const parsed = result.details;

    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.warning, undefined, "no sync-warning when the card mirror succeeds");
    const cards = await cardStore.getCardsByKind("memory");
    assert.strictEqual(cards.length, 1, "entry mirrored into the card store");
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
        added_md_id: "md-flaky-6666",
      }),
    } as unknown as MemoryStore;

    const persistentFlaky = failingCardStore("disk I/O error");

    registerMemoryTool(mockPi, mockStore, null, null, persistentFlaky);
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

    registerMemoryTool(mockPi, mockStore, null);
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

  // ── Task 7: failure lifecycle state/severity on add + edit ──────────────
  it("threads failure state + severity into the card envelope on add", async () => {
    let capturedResult: any;
    const mockPi = { registerTool: (def: any) => { capturedResult = def; } } as unknown as ExtensionAPI;
    const mockStore = {
      addFailure: () => ({
        success: true, target: "failure", entries: ["[failure] boom"],
        usage: "1% — 10/5000 chars", entry_count: 1, added_md_id: "md-add-1",
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, null, await makeCardStore());
    await capturedResult.execute(
      "tc-1",
      { action: "add", target: "failure", content: "boom", state: "resolved", severity: 2 },
      undefined as any, undefined as any, undefined as any,
    );

    const cards = await cardStore.getCardsByKind("failure");
    assert.strictEqual(cards.length, 1, "failure add must mirror a card");
    assert.match(cards[0].content, /^\[failure\] boom/);
    assert.strictEqual(cards[0].id, "md-add-1");
    assert.strictEqual(cards[0].frontmatter.state, "resolved");
    assert.strictEqual(cards[0].frontmatter.severity, 2);
  });

  it("omits state/severity from the card envelope when add omits them (default applies downstream)", async () => {
    let capturedResult: any;
    const mockPi = { registerTool: (def: any) => { capturedResult = def; } } as unknown as ExtensionAPI;
    const mockStore = {
      addFailure: () => ({
        success: true, target: "failure", entries: ["[failure] boom"],
        usage: "1% — 10/5000 chars", entry_count: 1, added_md_id: "md-add-2",
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, null, await makeCardStore());
    await capturedResult.execute(
      "tc-1",
      { action: "add", target: "failure", content: "boom" },
      undefined as any, undefined as any, undefined as any,
    );

    const cards = await cardStore.getCardsByKind("failure");
    assert.strictEqual(cards.length, 1);
    assert.strictEqual(cards[0].frontmatter.state, undefined, "no state in the envelope when omitted");
    assert.strictEqual(cards[0].frontmatter.severity, undefined, "no severity in the envelope when omitted");
  });

  it("drops severity outside 1–3 on add", async () => {
    let capturedResult: any;
    const mockPi = { registerTool: (def: any) => { capturedResult = def; } } as unknown as ExtensionAPI;
    const mockStore = {
      addFailure: () => ({
        success: true, target: "failure", entries: ["[failure] boom"],
        usage: "1% — 10/5000 chars", entry_count: 1, added_md_id: "md-add-3",
      }),
    } as unknown as MemoryStore;

    registerMemoryTool(mockPi, mockStore, null, null, await makeCardStore());
    await capturedResult.execute(
      "tc-1",
      { action: "add", target: "failure", content: "boom", severity: 9 },
      undefined as any, undefined as any, undefined as any,
    );

    const cards = await cardStore.getCardsByKind("failure");
    assert.strictEqual(cards[0].frontmatter.severity, undefined, "out-of-range severity is dropped");
  });

  it("threads failure state into the replacement card envelope on edit", async () => {
    let capturedResult: any;
    const mockPi = { registerTool: (def: any) => { capturedResult = def; } } as unknown as ExtensionAPI;
    const mockStore = {
      replace: () => ({
        success: true, target: "failure", entries: ["[failure] fixed"],
        usage: "1% — 10/5000 chars", entry_count: 1, added_md_id: "md-replace-1",
      }),
    } as unknown as MemoryStore;

    // Seed the old card row so the replace mirror finds + retires it.
    const store = await makeCardStore();
    const serializer = store.serializerFor("failure")!;
    const [prior] = serializer.deserialize([
      "---",
      'id: "md-prior-1"',
      'created: "2026-08-15"',
      'last: "2026-08-15"',
      "---",
      "[failure] boom",
    ].join("\n"));
    await store.upsertCard(prior);

    registerMemoryTool(mockPi, mockStore, null, null, store);
    const result = await capturedResult.execute(
      "tc-1",
      { action: "replace", target: "failure", old_text: "boom", content: "fixed", state: "acquired" },
      undefined as any, undefined as any, undefined as any,
    );

    // The old row is gone; exactly one card remains — the replacement, carrying state.
    const cards = await cardStore.getCardsByKind("failure");
    assert.deepStrictEqual(cards.map((c) => c.id), ["md-replace-1"], "old card deleted, replacement mirrored");
    assert.strictEqual(cards[0].frontmatter.state, "acquired");
    assert.strictEqual(result.details.warning, undefined, "matched old row → no stale-mirror warning");
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
