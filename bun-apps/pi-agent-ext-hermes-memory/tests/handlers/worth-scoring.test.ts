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
});
