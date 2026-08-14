import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { publishSeam, type KnowledgePipeline, type RetrieveResult } from "@repo/pi-agent-ext-core-interface";
import { registerKnowledgeSearchTool, buildLexicalRecall, buildEntityRecall } from "../src/tools/knowledge-search-tool.js";
import { SqliteBackend } from "../src/store/sqlite/sqlite-backend.js";
import { existsSync, writeFileSync } from "node:fs";

const KEY = "__piKnowledgePipeline";

/** A zk-shaped stub whose `retrieveRecords` returns the fixed `result`. */
function makeStubPipeline(result: RetrieveResult): KnowledgePipeline {
  return {
    collectInputFiles: () => ({ files: [], skipped: [] }),
    ingestRecords: async (_records, opts) => ({
      source: opts.source, sourceLabel: opts.sourceLabel, total: 0, created: 0, updated: 0,
      unchanged: 0, skipped: 0, linked: 0, wikiMerged: 0, mocUpdated: false,
      vaultPath: opts.vaultPath, folder: opts.folder ?? "", cards: [], parseErrors: [],
    }),
    runConvergenceLoop: async () => ({
      sourcesIngested: 0, created: 0, updated: 0, unchanged: 0, deadLinksBefore: 0, deadLinksAfter: 0,
      mocMissingBefore: false, mocMissingAfter: false, rounds: 0, converged: false, truncated: false, health: null,
    }),
    retrieveRecords: async () => result,
    healGraph: async () => ({ mocRegenerated: true, deadLinksPruned: 0, linksDeduped: 0, cardsTouched: [] }),
  };
}

/** Minimal registrar: captures the registered ToolDefinition so the test can
 *  drive its `execute`. Structurally assignable to the tool's narrow param type
 *  (no cast needed). */
function captureRegistrar(): { registerTool(def: ToolDefinition): void; def(): ToolDefinition | undefined } {
  let captured: ToolDefinition | undefined;
  return {
    registerTool(def: ToolDefinition): void {
      captured = def;
    },
    def(): ToolDefinition | undefined {
      return captured;
    },
  };
}

function textOf(out: { content: Array<{ type: string; text: string }> }): string {
  return out.content.map((c) => c.text).join("\n");
}

describe("knowledge_search tool", () => {
  let vault: string;

  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[KEY];
    delete process.env.KNOWLEDGE_VAULT_PATH;
    delete process.env.OB_VAULT_PATH;
    vault = mkdtempSync(join(tmpdir(), "kst-vault-"));
    process.env.KNOWLEDGE_VAULT_PATH = vault;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[KEY];
    delete process.env.KNOWLEDGE_VAULT_PATH;
    delete process.env.OB_VAULT_PATH;
    rmSync(vault, { recursive: true, force: true });
  });

  it("surfaces retrieveRecords cards (title in text; RetrieveResult in details)", async () => {
    const fixed: RetrieveResult = {
      count: 1,
      cards: [
        { id: "cfg-scale", title: "CFG Scale Lever", detail: "lower cfg for finer detail", tags: ["zettel", "cfg"] },
      ],
      digest: "1 match · ranked by shared tags",
      folder: "Zettelkasten/knowledge-graph",
      scanned: 5,
      excluded: 0,
    };
    publishSeam(KEY, makeStubPipeline(fixed));

    const pi = captureRegistrar();
    registerKnowledgeSearchTool(pi, () => vault);
    const def = pi.def();
    assert.ok(def, "knowledge_search tool registered");
    assert.equal(def!.name, "knowledge_search");
    assert.deepEqual(def!.gating, { core: true });

    const out = await def!.execute("call-1", { query: "cfg-scale" }, undefined, undefined, { });
    assert.match(textOf(out), /CFG Scale Lever/, "text contains the card title");
    assert.equal((out.details as RetrieveResult).count, 1);
    assert.equal((out.details as RetrieveResult).cards[0]!.id, "cfg-scale");
  });

  it("returns a graceful 'zk not present' result when the seam is absent", async () => {
    // Seam deliberately NOT published.
    const pi = captureRegistrar();
    registerKnowledgeSearchTool(pi, () => vault);
    const def = pi.def();
    assert.ok(def);
    const out = await def!.execute("call-1", { query: "anything" }, undefined, undefined, { });
    assert.match(textOf(out), /zk.*not present|seam not present/i);
    assert.equal((out.details as { ok: boolean }).ok, false);
  });

  it("surfaces a clear message when the vault env is unset (resolver throws)", async () => {
    const fixed: RetrieveResult = {
      count: 0, cards: [], digest: "", folder: "Zettelkasten/knowledge-graph", scanned: 0, excluded: 0,
    };
    publishSeam(KEY, makeStubPipeline(fixed));
    const pi = captureRegistrar();
    // A resolver that throws (mirrors resolveKnowledgeVaultPath when both envs unset).
    registerKnowledgeSearchTool(pi, () => {
      throw new Error("knowledge vault path not configured");
    });
    const def = pi.def();
    assert.ok(def);
    const out = await def!.execute("call-1", { query: "x" }, undefined, undefined, { });
    assert.match(textOf(out), /vault not configured/i);
  });
});

/** ── Ticket 20 T3: production signal builders ────────────────────────────
 *
 * Fixtures: a tmp memory dir seeded via a raw SqliteBackend (INSERT INTO
 * memories — the FTS triggers keep memory_fts in sync automatically), then a
 * FRESH ephemeral backend per builder call (mirroring production: the builders
 * open the card-store DB ephemerally per call, never share a handle). */
interface SeedRow {
  target: "knowledge" | "memory";
  content: string;
  mdId: string;
  graph?: string;
}

async function seedMemoryDir(rows: SeedRow[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "kst-signals-"));
  const backend = new SqliteBackend(dir);
  await backend.init();
  const db = backend.getDb();
  const insert = db.prepare(
    `INSERT INTO memories (target, content, created, last_referenced, md_id, graph) VALUES (?, ?, '2026-01-01', '2026-01-01', ?, ?)`,
  );
  for (const row of rows) {
    insert.run(row.target, row.content, row.mdId, row.graph ?? null);
  }
  await backend.close();
  return dir;
}

describe("buildLexicalRecall (FTS membership over target='knowledge')", () => {
  it("returns the knowledge card matching the query, excluding memory-target cards", async () => {
    const dir = await seedMemoryDir([
      { target: "knowledge", content: "quokka camera trap survey protocol", mdId: "md/knowledge/quokka" },
      { target: "memory", content: "quokka remembered feeding schedule", mdId: "md/memory/quokka" },
    ]);
    try {
      const recall = buildLexicalRecall(dir);
      const hits = await recall("quokka", 10);
      assert.deepEqual(hits, [{ mdId: "md/knowledge/quokka", rank: 0 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] (never throws) on an FTS-hostile query", async () => {
    const dir = await seedMemoryDir([
      { target: "knowledge", content: "cfg scale tuning for finer detail", mdId: "md/knowledge/cfg" },
    ]);
    try {
      const recall = buildLexicalRecall(dir);
      const hits = await recall('"unterminated', 10);
      assert.ok(Array.isArray(hits));
      // Fallback may rescue quoted-term queries; hostile input must at worst [].
      assert.ok(hits.every((h) => typeof h.mdId === "string" && typeof h.rank === "number"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] (never throws) on a corrupt database file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kst-corrupt-"));
    writeFileSync(join(dir, "sessions.db"), "not a sqlite database at all");
    try {
      const recall = buildLexicalRecall(dir);
      const hits = await recall("anything", 10);
      assert.deepEqual(hits, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildEntityRecall (query entities × paged graph scan)", () => {
  it("recalls cards by normalized entity name, ranked by matchCount desc", async () => {
    const dir = await seedMemoryDir([
      {
        target: "knowledge",
        content: "card a",
        mdId: "md/knowledge/a",
        graph: JSON.stringify({ entities: [{ type: "tool", name: "run.py" }, { type: "lib", name: "MLX" }] }),
      },
      {
        target: "knowledge",
        content: "card b",
        mdId: "md/knowledge/b",
        graph: JSON.stringify({ entities: [{ type: "tool", name: "run.py" }] }),
      },
      {
        target: "knowledge",
        content: "card c",
        mdId: "md/knowledge/c",
        graph: JSON.stringify({ entities: [{ type: "tool", name: "Docker" }] }),
      },
    ]);
    try {
      const recall = buildEntityRecall(dir);
      // extractEntities on this query yields (at least) `run.py` + `MLX`
      // (backtick spans — the highest-precision pass; bare MLX is filtered as
      // a vowel-less single capital, so the fixture quotes it).
      const hits = await recall("how to run `run.py` with `MLX` on Apple Silicon", 10);
      assert.deepEqual(hits, [
        { mdId: "md/knowledge/a", rank: 0 }, // 2 matches → first
        { mdId: "md/knowledge/b", rank: 1 }, // 1 match → second
        // card c (Docker only) absent — no overlap with the query entity set
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("silently skips malformed graph JSON", async () => {
    const dir = await seedMemoryDir([
      { target: "knowledge", content: "broken", mdId: "md/knowledge/broken", graph: "{not json" },
      {
        target: "knowledge",
        content: "good",
        mdId: "md/knowledge/good",
        graph: JSON.stringify({ entities: [{ type: "lib", name: "MLX" }] }),
      },
    ]);
    try {
      const recall = buildEntityRecall(dir);
      const hits = await recall("tuning `MLX` pipelines", 10);
      assert.deepEqual(hits, [{ mdId: "md/knowledge/good", rank: 0 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("short-circuits to [] WITHOUT opening the DB when the query has no entities", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kst-noent-"));
    try {
      const recall = buildEntityRecall(dir);
      const hits = await recall("x", 10); // single lowercase letter → no entities
      assert.deepEqual(hits, []);
      assert.equal(existsSync(join(dir, "sessions.db")), false, "must not open/create the DB");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] (never throws) on a corrupt database file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kst-corrupt-ent-"));
    writeFileSync(join(dir, "sessions.db"), "garbage not a database");
    try {
      const recall = buildEntityRecall(dir);
      const hits = await recall("running `run.py` under MLX", 10);
      assert.deepEqual(hits, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
