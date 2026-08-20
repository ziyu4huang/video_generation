/**
 * Unit tests for the worth-scoring trigger — RecallSet + setupWorthScoring.
 *
 * The trigger reuses the EXPORTED `isCorrection` predicate from
 * correction-detector.ts to flag `hadCorrection` on `message_end`, then drains
 * the shared RecallSet at `turn_end` and bumps each recalled memory's worth
 * (mw_fail on correction, else mw_success). Best-effort, DB-authoritative,
 * always drains. Mirrors correction-detector.test.ts's SqliteBackend scaffold.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "../../src/store/sqlite/sqlite-memory-repo.js";
import { RecallSet, setupWorthScoring } from "../../src/handlers/worth-scoring.js";
import { registerSearchTool } from "../../src/tools/search-tool.js";

describe("worth-scoring handler", () => {
  let tmpDir: string; let backend: SqliteBackend; let repo: SqliteMemoryRepository;
  let handlers: Record<string, Array<(e: any, ctx?: any) => Promise<void> | void>>;
  let recallSet: RecallSet;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worth-scoring-"));
    backend = new SqliteBackend(tmpDir);
    repo = new SqliteMemoryRepository(backend);
    handlers = {};
    recallSet = new RecallSet();
    const mockPi = { on: (ev: string, h: any) => { (handlers[ev] ??= []).push(h); }, registerTool() {}, registerCommand() {} } as any;
    setupWorthScoring(mockPi, repo, recallSet, { worthScoring: true } as any);
  });
  afterEach(() => { backend.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  const fire = async (ev: string, e: any, ctx?: any) => { for (const h of handlers[ev] ?? []) await h(e, ctx); };

  it("clean turn: bumps mw_success on the recalled set", async () => {
    const m = await repo.addMemory({ content: "use bun", target: "memory" });
    recallSet.record(m.id);
    await fire("message_end", { message: { role: "user", content: [{ type: "text", text: "thanks, that worked" }] } });
    await fire("turn_end", {}, {});
    const got = await repo.getMemories({ target: "memory" });
    assert.strictEqual(got[0].mwSuccess, 1);
    assert.strictEqual(got[0].mwFail, 0);
  });

  it("correction turn: bumps mw_fail on the recalled set", async () => {
    const m = await repo.addMemory({ content: "use npm", target: "memory" });
    recallSet.record(m.id);
    await fire("message_end", { message: { role: "user", content: [{ type: "text", text: "no, use pnpm instead" }] } });
    await fire("turn_end", {}, {});
    const got = await repo.getMemories({ target: "memory" });
    assert.strictEqual(got[0].mwFail, 1);
    assert.strictEqual(got[0].mwSuccess, 0);
  });

  it("empty recall-set: turn_end is a no-op (but drains)", async () => {
    await repo.addMemory({ content: "x", target: "memory" });
    await fire("turn_end", {}, {});
    const got = await repo.getMemories({ target: "memory" });
    assert.strictEqual(got[0].mwSuccess ?? 0, 0);
  });

  it("worthScoring disabled: no bump, but recall-set still drains", async () => {
    // re-setup with worthScoring:false
    handlers = {}; recallSet = new RecallSet();
    const mockPi = { on: (ev: string, h: any) => { (handlers[ev] ??= []).push(h); }, registerTool() {}, registerCommand() {} } as any;
    setupWorthScoring(mockPi, repo, recallSet, { worthScoring: false } as any);
    const m = await repo.addMemory({ content: "y", target: "memory" });
    recallSet.record(m.id);
    await fire("turn_end", {}, {});
    assert.strictEqual(recallSet.drain().length, 0); // drained, not grown
    const got = await repo.getMemories({ target: "memory" });
    assert.strictEqual(got[0].mwSuccess ?? 0, 0);
  });

  it("lesson-worthy tool error on a recalled memory: bumps mw_fail", async () => {
    const m = await repo.addMemory({ content: "use pnpm to add deps", target: "memory" });
    recallSet.record(m.id);
    // a tool_result that failed with a lesson-worthy error text
    await fire("tool_result", {
      isError: true,
      content: [{ type: "text", text: "Error: ENOENT: no such file or directory, open '/missing.cfg'" }],
      toolName: "read",
    });
    await fire("turn_end", {}, {});
    const got = await repo.getMemories({ target: "memory" });
    assert.strictEqual(got[0].mwFail, 1);
    assert.strictEqual(got[0].mwSuccess, 0);
  });

  it("non-error tool_result: counts as success (not fail)", async () => {
    const m = await repo.addMemory({ content: "use bun test", target: "memory" });
    recallSet.record(m.id);
    await fire("tool_result", {
      isError: false,
      content: [{ type: "text", text: "ran fine" }],
      toolName: "bash",
    });
    await fire("turn_end", {}, {});
    const got = await repo.getMemories({ target: "memory" });
    assert.strictEqual(got[0].mwSuccess, 1);
    assert.strictEqual(got[0].mwFail, 0);
  });

  it("error that is NOT lesson-worthy (noise-suppressed): does not bump mw_fail", async () => {
    const m = await repo.addMemory({ content: "run the linter", target: "memory" });
    recallSet.record(m.id);
    // isError:true BUT the text matches an ERROR_NOISE_PATTERN (`operation aborted`),
    // so isLessonWorthy() returns false → hadError stays false → clean turn → mw_success.
    await fire("tool_result", {
      isError: true,
      content: [{ type: "text", text: "operation aborted by the user" }],
      toolName: "bash",
    });
    await fire("turn_end", {}, {});
    const got = await repo.getMemories({ target: "memory" });
    assert.strictEqual(got[0].mwFail ?? 0, 0);
    assert.strictEqual(got[0].mwSuccess, 1); // clean turn otherwise → success
  });
});

describe("worth-scoring end-to-end (search → correction turn → bump)", () => {
  let tmpDir: string; let backend: SqliteBackend; let repo: SqliteMemoryRepository;
  let handlers: Record<string, Array<(e: any, ctx?: any) => Promise<void> | void>>;
  let tools: Record<string, any>; let recallSet: RecallSet;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "worth-e2e-"));
    backend = new SqliteBackend(tmpDir);
    repo = new SqliteMemoryRepository(backend);
    handlers = {}; tools = {}; recallSet = new RecallSet();
    const pi: any = {
      on: (ev: string, h: any) => { (handlers[ev] ??= []).push(h); },
      registerTool: (def: any) => { tools[def.name] = def; },
      registerCommand() {},
    };
    setupWorthScoring(pi, repo, recallSet, { worthScoring: true } as any);
    registerSearchTool(pi, repo, {} as any, { variant: "legacy" } as any, recallSet);
  });
  afterEach(() => { backend.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); });
  const fire = async (ev: string, e: any, ctx?: any) => { for (const h of handlers[ev] ?? []) await h(e, ctx); };

  it("a search that recalls a memory, followed by a correction turn, bumps mw_fail", async () => {
    const m = await repo.addMemory({ content: "always commit on the main branch", target: "memory" });
    // recall it via the wired search tool in memory mode (populates recallSet)
    // (`search` renamed to `search_memory` 2026-08-20 — docs/agents/extension-naming.md)
    await tools.search_memory.execute("tc", { mode: "memory", query: "commit branch", target: "memory" });
    // correction turn — message_end flags hadCorrection, turn_end drains + bumps
    await fire("message_end", { message: { role: "user", content: [{ type: "text", text: "no, use feature branches instead" }] } });
    await fire("turn_end", {}, {});
    const got = (await repo.getMemories({ target: "memory" })).find((x) => x.id === m.id)!;
    assert.strictEqual(got.mwFail, 1);
    assert.strictEqual(got.mwSuccess, 0);
  });
});
