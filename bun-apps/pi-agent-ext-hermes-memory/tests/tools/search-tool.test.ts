import { describe, it, afterEach } from "bun:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteBackend } from "../../src/store/sqlite/sqlite-backend.js";
import { SqliteMemoryRepository } from "../../src/store/sqlite/sqlite-memory-repo.js";
import { registerSearchTool } from "../../src/tools/search-tool.js";
import { RecallSet } from "../../src/handlers/worth-scoring.js";

let ROOT_DIR = "";
let backend: SqliteBackend | null = null;

afterEach(async () => {
  if (backend) { await backend.close(); backend = null; }
  if (ROOT_DIR) fs.rmSync(ROOT_DIR, { recursive: true, force: true });
  ROOT_DIR = "";
});

function makeMemoryRepo(): SqliteMemoryRepository {
  ROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-search-tool-test-"));
  backend = new SqliteBackend(ROOT_DIR);
  return new SqliteMemoryRepository(backend);
}

function capturePi(): { pi: any; captured: () => any } {
  let captured: any;
  const pi = {
    registerTool: (def: any) => { captured = def; },
  } as any;
  return { pi, captured: () => captured };
}

describe("registerSearchTool (memory mode)", () => {
  it("returns a broader natural-language match when strict term matching misses", async () => {
    const memoryRepo = makeMemoryRepo();
    await memoryRepo.addMemory({ content: "user's name is Naruto", target: "user" });

    const { pi, captured } = capturePi();
    registerSearchTool(pi, memoryRepo, {} as any);

    const result = await captured().execute("tc-1", { mode: "memory", query: "name identity Naruto", target: "user" });

    assert.strictEqual(result.details.success, true);
    assert.strictEqual(result.details.count, 1);
    assert.match(result.content[0].text, /Naruto/);
  });

  it("bumps last_referenced for matched entries (touch-on-search wiring)", async () => {
    const memoryRepo = makeMemoryRepo();
    const old = "2020-01-01";
    const added = await memoryRepo.addMemory({
      content: "user's name is Naruto",
      target: "user",
      created: old,
      lastReferenced: old,
    });
    assert.strictEqual(added.lastReferenced, old, "precondition: last_referenced starts old");

    const { pi, captured } = capturePi();
    registerSearchTool(pi, memoryRepo, {} as any);

    const result = await captured().execute("tc-touch", { mode: "memory", query: "name identity Naruto", target: "user" });
    assert.strictEqual(result.details.success, true);

    // After search, last_referenced must be bumped to today (the live 'last surfaced' signal)
    const row = backend!.getDb().prepare("SELECT created, last_referenced FROM memories WHERE id = ?").get(added.id) as { created: string; last_referenced: string };
    const todayStr = new Date().toISOString().split("T")[0];
    assert.strictEqual(row.last_referenced, todayStr, "search bumped last_referenced to today");
    assert.strictEqual(row.created, old, "created is preserved (not mutated by touch)");
  });

  it("records recalled ids into the recall-set (search memory mode → worth producer wiring)", async () => {
    const memoryRepo = makeMemoryRepo();
    await memoryRepo.addMemory({ content: "user's name is Naruto", target: "user" });
    const recallSet = new RecallSet();

    const { pi, captured } = capturePi();
    registerSearchTool(pi, memoryRepo, {} as any, { variant: "legacy" } as any, recallSet);

    await captured().execute("tc-recall", { mode: "memory", query: "name identity Naruto", target: "user" });

    // The recalled entry's id must be recorded into the shared recall-set so
    // setupWorthScoring can later bump its mw_success/mw_fail at turn_end.
    const drained = recallSet.drain();
    assert.ok(drained.length > 0, "at least the recalled entry was recorded");
  });
});

// In the retired session_search tool the legacy variant's schema omitted the
// `markdown` param; in the unified `search` tool the schema is shared across
// variants (markdown is always present, only used by the anchors variant), so
// the legacy assertions pin the mode selector + query params instead.
describe("registerSearchTool (session mode, legacy variant)", () => {
  it("registers the unified schema with the mode selector by default", () => {
    const { pi, captured } = capturePi();

    registerSearchTool(pi, {} as any, {} as any);

    const schema = JSON.stringify(captured().parameters);
    assert.strictEqual(captured().name, "search_memory");
    assert.match(schema, /mode/);
    assert.match(schema, /memory/);
    assert.match(schema, /session/);
    assert.match(schema, /query/);
  });
});

describe("registerSearchTool (session mode, anchors variant)", () => {
  it("registers and executes the anchor markdown-only behavior when configured", async () => {
    const { pi, captured } = capturePi();
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-search-tool-test-"));
    ROOT_DIR = sessionsDir;
    const filePath = path.join(sessionsDir, "session.jsonl");
    fs.writeFileSync(filePath, `${JSON.stringify({
      type: "message",
      timestamp: "2026-05-15T10:00:00.000Z",
      sessionId: "session-1",
      cwd: "/work/project",
      message: { role: "user", content: "needle" },
    })}\n`);

    // Anchor mode does not use the repos — any objects are fine.
    registerSearchTool(pi, {} as any, {} as any, { variant: "anchors" }, undefined, { sessionsDir });

    const schema = JSON.stringify(captured().parameters);
    assert.strictEqual(captured().name, "search_memory");
    assert.match(schema, /markdown/);
    assert.match(schema, /query/);
    assert.match(captured().description, /all terms must match/);
    assert.match(captured().description, /any \(at least one must match\)/);
    assert.match(captured().description, /exclude \(drops matches\)/);
    assert.match(captured().description, /compact JSONL line-range anchors/);
    assert.match(captured().description, /Example:\nfrom: 2026-05-14/);

    const empty = await captured().execute("tc-1", { mode: "session", markdown: "" });
    assert.strictEqual(empty.details.success, false);
    assert.strictEqual(empty.details.message, "markdown is required");

    const result = await captured().execute("tc-2", { mode: "session", markdown: "any:\n- needle" });
    assert.strictEqual(result.details.success, true);
    assert.strictEqual(result.details.count, 1);
    assert.deepStrictEqual(result.details.ranges.map((range: any) => ({
      path: range.path,
      startLine: range.startLine,
      endLine: range.endLine,
      reason: range.reason,
    })), [{ path: filePath, startLine: 1, endLine: 1, reason: "matched any: needle" }]);
    assert.strictEqual(result.details.output, result.content[0].text);
    assert.match(result.content[0].text, /^count: 1\nanchors:\n-/);
    assert.match(result.content[0].text, new RegExp(`${filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:1-1 — matched any: needle`));
    assert.doesNotMatch(result.content[0].text, /"ranges"/);
    assert.doesNotMatch(result.content[0].text, /"startLine"/);
    assert.doesNotMatch(result.content[0].text, /"sessionId"/);
  });
});
