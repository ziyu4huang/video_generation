/**
 * Unit tests for supersede via the `memory` tool's ACTION dispatch —
 * replacement + lineage flip + probe (kp14 consolidation: the standalone
 * memory_supersede tool retired; the body lives in executeMemorySupersede,
 * dispatched by registerMemoryTool's `action:"supersede"` case which wraps
 * its plain-string return in this tool's {content, details} envelope).
 *
 * Mirrors memory-tool.test.ts's mock-store + real-SqliteMemoryRepository +
 * mock-pi scaffold. kp13 Wave B: the replacement mirrors through the bundle
 * CardStore (md_id-keyed upsert; the cardStore below is joined on the SAME
 * backend, so the card row lands in the same memories table the repo reads).
 * The CRITICAL seam stays the row-id resolution: executeMemorySupersede
 * resolves the mirrored row's NUMERIC id by md_id (content fallback) so
 * lineage can be flipped onto the real new row id — surfaced to tests only
 * via the `Superseded memory #<prior> with #<new>.` text.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerMemoryTool } from "../../src/tools/memory-tool.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "../../src/store/sqlite/sqlite-memory-repo.js";
import { createCardStore } from "../../src/store/card-store.js";
import type { CardStore } from "../../src/store/card-store.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

describe("memory tool supersede action", () => {
  let tmpDir: string;
  let backend: SqliteBackend;
  let memoryRepo: SqliteMemoryRepository;
  let cardStore: CardStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-supersede-tool-test-"));
    backend = new SqliteBackend(tmpDir);
    memoryRepo = new SqliteMemoryRepository(backend);
    cardStore = await createCardStore({ memoryDir: tmpDir, sqliteBackend: backend });
  });

  afterEach(async () => {
    await cardStore.close();
    await backend.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Mock-pi that captures the single registered tool definition. */
  function captureTool(): { pi: ExtensionAPI; def: () => any } {
    let captured: any;
    const pi = {
      registerTool: (def: any) => {
        captured = def;
      },
    } as unknown as ExtensionAPI;
    return { pi, def: () => captured };
  }

  /** Mock MemoryStore whose `add` pretends the .md write succeeded (F1: the
   *  birth id threads through, exactly like the real store's added_md_id). */
  function mockStore(addedMdId = "md-supersede-new-1"): MemoryStore {
    return {
      add: () => ({
        success: true,
        target: "memory",
        entries: ["replacement"],
        usage: "1% — 10/5000 chars",
        entry_count: 1,
        message: "Entry added.",
        added_md_id: addedMdId,
      }),
    } as unknown as MemoryStore;
  }

  /** Extract the new row id from the `Superseded memory #<prior> with #<new>.`
   *  text (the plain-string handler's only id surface). */
  function newIdFromText(text: string): number {
    const m = /Superseded memory #(\d+) with #(\d+)\./.exec(text);
    assert.ok(m, `text should carry the supersede ids: ${text}`);
    return Number(m[2]);
  }

  it("registers the memory tool with supersede params on its schema", () => {
    const { pi, def } = captureTool();
    registerMemoryTool(pi, mockStore(), null, null, cardStore, memoryRepo);

    const tool = def();
    assert.strictEqual(tool.name, "memory");
    assert.strictEqual(tool.label, "Memory");
    assert.ok(tool.description.length > 0);
    assert.ok(tool.parameters, "parameters schema should be defined");
    // action enum carries supersede; supersede params present
    assert.ok(
      JSON.stringify(tool.parameters.properties.action).includes("supersede"),
      "action enum includes supersede",
    );
    assert.ok(tool.parameters.properties.prior_id, "prior_id param present");
    assert.ok(tool.parameters.properties.replacement, "replacement param present");
    assert.ok(tool.parameters.properties.sources, "sources param present");
    assert.ok(tool.parameters.required.includes("action"));
    assert.ok(tool.parameters.required.includes("target"));
    assert.strictEqual(typeof tool.execute, "function");
  });

  it("creates a linked replacement, flips the prior to superseded, and verifies via probe", async () => {
    // 1. Seed a prior memory directly in the DB (simulates a memory_search hit).
    const prior = await memoryRepo.addMemory({
      content: "deploy strategy review alpha approach",
      target: "memory",
      project: null,
    });

    // 2. Register the memory tool against the real repo + a mock .md store.
    const { pi, def } = captureTool();
    registerMemoryTool(pi, mockStore(), null, null, cardStore, memoryRepo);

    // 3. Execute supersession as a memory ACTION. The replacement shares its
    //    first 3 words with the prior so the probe's lexical handle would
    //    naturally match BOTH — only the status filter can hide the prior.
    const result = await def().execute(
      "tc-1",
      {
        action: "supersede",
        prior_id: prior.id,
        replacement: "deploy strategy review beta approach",
        target: "memory",
      },
      undefined as any,
      undefined as any,
      undefined as any,
    );

    // 4. Envelope shape: memory-tool supersede wrapper (plain-string body).
    assert.strictEqual(result.content[0].type, "text");
    assert.deepStrictEqual((result as any).details, {
      success: true,
      action: "supersede",
      target: "memory",
    });

    const text: string = result.content[0].text;
    assert.match(text, /Superseded memory #\d+ with #\d+\./);
    assert.match(text, /Probe: replacement present, prior hidden\./);
    const newId = newIdFromText(text);
    assert.ok(typeof newId === "number", "newId must be a number");
    assert.notStrictEqual(newId, prior.id, "newId must differ from prior.id");

    // 5. New entry carries lineage back to the prior + stays active.
    const all = await memoryRepo.getMemories();
    const newRow = all.find((m) => m.id === newId)!;
    assert.ok(newRow, "replacement row exists in DB");
    assert.strictEqual(newRow.status, "active");
    assert.strictEqual(newRow.supersedes, prior.id);
    assert.deepStrictEqual(newRow.parentIds, [prior.id]);

    // 6. Prior is flipped to superseded, pointing at the replacement.
    const priorRow = all.find((m) => m.id === prior.id)!;
    assert.strictEqual(priorRow.status, "superseded");
    assert.strictEqual(priorRow.supersededBy, newId);

    // 7. Probe: search the replacement's 3-word handle. The prior lexically
    //    matches too, but the status filter hides it — so priorAbsent is the
    //    filter working, not lexical luck.
    const hits = await memoryRepo.searchMemories("deploy strategy review");
    assert.ok(hits.some((h) => h.id === newId), "replacement is searchable");
    assert.ok(!hits.some((h) => h.id === prior.id), "prior is hidden by status filter");

    // 8. kp13 Wave B: the replacement mirrored as an md_id-keyed card.
    const mirrored = await cardStore.getCard("md-supersede-new-1");
    assert.ok(mirrored, "replacement card mirrored into the card store");
    assert.strictEqual(mirrored.content, "deploy strategy review beta approach");
    assert.strictEqual(mirrored.kind, "memory");
  });

  it("soft-succeeds when no search store is wired (replacement still saved to .md)", async () => {
    const prior = await memoryRepo.addMemory({
      content: "stale note about config path",
      target: "memory",
      project: null,
    });

    const { pi, def } = captureTool();
    // memoryRepo = null → no DB to link lineage against.
    registerMemoryTool(pi, mockStore(), null, null, null, null); // no repo, no cardStore — soft path

    const result = await def().execute(
      "tc-1",
      {
        action: "supersede",
        prior_id: prior.id,
        replacement: "corrected config path note",
        target: "memory",
      },
      undefined as any,
      undefined as any,
      undefined as any,
    );

    assert.strictEqual((result as any).details.success, true, "soft success envelope");
    assert.match(
      result.content[0].text,
      /Replacement saved to Markdown, but no search store is configured — lineage could not be linked\./,
    );
    // DB untouched: prior still active, no replacement row.
    const rows = await memoryRepo.getMemories();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].id, prior.id);
    assert.strictEqual(rows[0].status, "active");
  });

  it("survives a supersedeMemory failure: replacement saved, lineage unlinked, recoverable", async () => {
    const prior = await memoryRepo.addMemory({
      content: "failing lineage prior content",
      target: "memory",
      project: null,
    });

    // Repo that syncs fine but blows up at the lineage step.
    const flakyRepo = {
      getMemories: async (o?: any) => memoryRepo.getMemories(o),
      supersedeMemory: async () => {
        throw new Error("lineage linkboom");
      },
      searchMemories: async (q: string, o?: any) => memoryRepo.searchMemories(q, o),
    } as unknown as SqliteMemoryRepository;

    const { pi, def } = captureTool();
    registerMemoryTool(pi, mockStore(), null, null, cardStore, flakyRepo);

    const result = await def().execute(
      "tc-1",
      {
        action: "supersede",
        prior_id: prior.id,
        replacement: "failing lineage replacement content",
        target: "memory",
      },
      undefined as any,
      undefined as any,
      undefined as any,
    );

    assert.strictEqual((result as any).details.success, true, "replacement was persisted to .md + DB sync succeeded");
    // Recoverable retry hint in the text.
    assert.match(result.content[0].text, /lineage link failed: lineage linkboom/);
    assert.match(result.content[0].text, /retry memory_supersede/);
  });

  it("probe degrades when search throws (supersede still succeeds)", async () => {
    const prior = await memoryRepo.addMemory({
      content: "probe throw prior content here",
      target: "memory",
      project: null,
    });

    const probeThrowRepo = {
      getMemories: async (o?: any) => memoryRepo.getMemories(o),
      supersedeMemory: async (p: number, n: number) => memoryRepo.supersedeMemory(p, n),
      searchMemories: async () => {
        throw new Error("search exploded");
      },
    } as unknown as SqliteMemoryRepository;

    const { pi, def } = captureTool();
    registerMemoryTool(pi, mockStore("md-supersede-new-2"), null, null, cardStore, probeThrowRepo);

    const result = await def().execute(
      "tc-1",
      {
        action: "supersede",
        prior_id: prior.id,
        replacement: "probe throw replacement content here",
        target: "memory",
      },
      undefined as any,
      undefined as any,
      undefined as any,
    );

    assert.strictEqual((result as any).details.success, true);
    const text: string = result.content[0].text;
    assert.match(text, /Superseded memory #\d+ with #\d+\./, "lineage still flipped");
    assert.match(text, /Probe skipped \(search unavailable\)\./, "probe degrades on throw");

    // Lineage really flipped in the DB.
    const newId = newIdFromText(text);
    const all = await memoryRepo.getMemories();
    const newRow = all.find((m) => m.id === newId)!;
    assert.strictEqual(newRow.supersedes, prior.id);
  });

  it("threads optional sources[] into store.add (grounding the replacement)", async () => {
    const prior = await memoryRepo.addMemory({
      content: "stale grounding note alpha",
      target: "memory",
      project: null,
    });

    // Spy store: capture the options object handed to add().
    let capturedOptions: { sources?: unknown } | undefined;
    const spyStore = {
      add: (_target: string, _content: string, options?: { sources?: unknown }) => {
        capturedOptions = options;
        return { success: true, target: "memory", entries: ["replacement"], usage: "1%", entry_count: 1, message: "Entry added.", added_md_id: "md-src-1" };
      },
    } as unknown as MemoryStore;

    const { pi, def } = captureTool();
    registerMemoryTool(pi, spyStore, null, null, cardStore, memoryRepo);

    const sources = [
      { kind: "quote", locator: "session-42#m7", capture: "no, the value is 3 not 2" },
      { kind: "doc", locator: "README.md#L120", capture: "VALUE = 3" },
    ];

    const result = await def().execute(
      "tc-src",
      {
        action: "supersede",
        prior_id: prior.id,
        replacement: "the value is 3 grounding note alpha",
        target: "memory",
        sources,
      },
      undefined as any, undefined as any, undefined as any,
    );

    assert.strictEqual((result as any).details.success, true);
    assert.match(result.content[0].text, /Superseded memory #\d+ with #\d+\./, "lineage linked");
    assert.ok(capturedOptions, "store.add was called");
    assert.deepStrictEqual(capturedOptions!.sources, sources, "sources[] passed through to store.add verbatim");
  });

  it("omitting sources still works (store.add called without sources)", async () => {
    const prior = await memoryRepo.addMemory({ content: "no sources prior content", target: "memory", project: null });
    let capturedOptions: { sources?: unknown } | undefined;
    const spyStore = {
      add: (_t: string, _c: string, options?: { sources?: unknown }) => {
        capturedOptions = options;
        return { success: true, target: "memory", entries: ["r"], usage: "1%", entry_count: 1, message: "ok", added_md_id: "md-nosrc-1" };
      },
    } as unknown as MemoryStore;

    const { pi, def } = captureTool();
    registerMemoryTool(pi, spyStore, null, null, cardStore, memoryRepo);

    const result = await def().execute(
      "tc-nosrc",
      {
        action: "supersede",
        prior_id: prior.id,
        replacement: "no sources replacement content",
        target: "memory",
      },
      undefined as any, undefined as any, undefined as any,
    );

    assert.strictEqual((result as any).details.success, true);
    assert.match(result.content[0].text, /Superseded memory #\d+ with #\d+\./, "lineage linked");
    assert.ok((capturedOptions === undefined) || (capturedOptions && capturedOptions.sources === undefined),
      "no sources param → store.add gets no sources");
  });
});
