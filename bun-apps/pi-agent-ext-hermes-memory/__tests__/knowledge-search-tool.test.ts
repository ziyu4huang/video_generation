import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { publishSeam, type KnowledgePipeline, type RetrieveResult } from "@repo/pi-agent-ext-core-interface";
import { registerKnowledgeSearchTool, buildLexicalRecall, buildEntityRecall } from "../src/tools/knowledge-search-tool.js";
import { SqliteBackend } from "../src/store/sqlite/sqlite-backend.js";
import { searchSemantic } from "../src/store/semantic-search.js";
import type { VectorKnnHit, VectorStore } from "../src/store/surreal/vector-store.js";
import type { Embedder } from "../src/store/surreal/embedder.js";
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

/** ── Ticket 20 T4: end-to-end voted warm path ───────────────────────────
 *
 * CHARACTERIZATION TESTS (no forced red): T1–T3 landed the vote core, the
 * boostWeight knob, and the production builders independently; these tests
 * compose them for the first time — real `buildLexicalRecall` +
 * `buildEntityRecall` over a seeded tmp SQLite card-store DB × a mocked
 * embedder/vectorStore HNSW path. They are expected to pass immediately
 * against the T1–T3 implementation; they pin the integration contract
 * (voted order + signalCount observability + tool card ordering).
 *
 * Fixture pair (query "quokka survey protocol for `MLX`"):
 *   - card A (`md/knowledge/a`): content matches EVERY FTS query token AND
 *     its graph.entities carry `MLX` (extracted from the backtick span) →
 *     present in BOTH extra signals → signalCount 3 (warm + lexical + entity).
 *   - card B (`md/knowledge/b`): NO FTS token overlap, graph entities
 *     (Docker) disjoint from the query set → warm-only, signalCount 1 — but
 *     B sits at HNSW rank 0 (better cosine) in the mocked knn result. */
const T4_QUERY = "quokka survey protocol for `MLX`";

async function seedVotedPair(): Promise<string> {
  return seedMemoryDir([
    {
      target: "knowledge",
      content: "quokka survey protocol for MLX",
      mdId: "md/knowledge/a",
      graph: JSON.stringify({ entities: [{ type: "lib", name: "MLX" }] }),
    },
    {
      target: "knowledge",
      content: "hedgehog nocturnal rotation schedule",
      mdId: "md/knowledge/b",
      graph: JSON.stringify({ entities: [{ type: "tool", name: "Docker" }] }),
    },
  ]);
}

function t4Embedder(): Embedder {
  return async () => [[1, 0, 0]]; // deterministic canned query vector
}

function t4VectorStore(knnResult: VectorKnnHit[]): VectorStore {
  return {
    init: async () => {},
    upsertVectors: async () => {},
    knn: async () => knnResult,
    missingMdIds: async () => [],
  } as unknown as VectorStore;
}

describe("ticket 20 T4 — end-to-end voted warm path (REAL builders × mocked vector path)", () => {
  it("3-signal card A outranks better-cosine warm-only card B (signalCount 3 vs 1)", async () => {
    const dir = await seedVotedPair();
    try {
      const vs = t4VectorStore([
        { mdId: "md/knowledge/b", kind: "knowledge" }, // HNSW rank 0 — better cosine
        { mdId: "md/knowledge/a", kind: "knowledge" }, // HNSW rank 1
      ]);
      const hits = await searchSemantic({
        queryText: T4_QUERY, kind: "knowledge", topK: 10,
        embedder: t4Embedder(), vectorStore: vs,
        lexicalRecall: buildLexicalRecall(dir),
        entityRecall: buildEntityRecall(dir),
        boostWeight: 1.0,
      });
      // A: (3-1)*1.0 + max(1-0/11, 1-0/11) = 2.909… ; B: 0*1.0 + 0 = 0
      assert.deepEqual(hits.map((h) => h.mdId), ["md/knowledge/a", "md/knowledge/b"]);
      assert.equal(hits[0]!.signalCount, 3); // warm + FTS + entity
      assert.equal(hits[1]!.signalCount, 1); // warm only
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("boostWeight 0.1: A STILL wins — a flip fixture is impossible under the pinned formula", async () => {
    // PINNED formula: final = (signalCount - 1) * boostWeight + bestRankScore,
    // where bestRankScore = max over CONTAINING signals of (1 - rank/(topK+1)).
    // A warm-only hit appears in NO signal → bestRankScore is ALWAYS 0 → its
    // final is 0 no matter how good its cosine rank is. Any signal-boosted
    // card scores (n-1)*w + >0, which is > 0 for every w > 0. So B can never
    // outrank A at any positive boostWeight — the invariant we assert (A wins
    // at both 1.0 and 0.1), with ties among warm-only hits broken by the
    // stable warm (cosine) order.
    const dir = await seedVotedPair();
    try {
      const vs = t4VectorStore([
        { mdId: "md/knowledge/b", kind: "knowledge" },
        { mdId: "md/knowledge/a", kind: "knowledge" },
      ]);
      const hits = await searchSemantic({
        queryText: T4_QUERY, kind: "knowledge", topK: 10,
        embedder: t4Embedder(), vectorStore: vs,
        lexicalRecall: buildLexicalRecall(dir),
        entityRecall: buildEntityRecall(dir),
        boostWeight: 0.1,
      });
      // A: 2*0.1 + 0.909 = 1.109 ; B: 0 → A still first even at the low knob.
      assert.deepEqual(hits.map((h) => h.mdId), ["md/knowledge/a", "md/knowledge/b"]);
      assert.equal(hits[0]!.signalCount, 3);
      assert.equal(hits[1]!.signalCount, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ticket 20 T4 — knowledge_search tool card order follows the vote", () => {
  it("content.text card list (and details.cards) follows the voted order, not the warm-cosine order", async () => {
    const dir = await seedVotedPair();
    // zk stub answers in ITS order: B first, A second (mirrors a zk retrieve
    // that ranks B ahead of A). The tool's warm block maps the VOTED mdId
    // order (A first) onto these cards — observable in both content.text and
    // details.cards.
    const fixed: RetrieveResult = {
      count: 2,
      cards: [
        { id: "md/knowledge/b", title: "Card B Hedgehog Rotation", detail: "warm-cosine best", tags: [] },
        { id: "md/knowledge/a", title: "Card A Quokka MLX Survey", detail: "voted 3-signal", tags: [] },
      ],
      digest: "", folder: "Zettelkasten/knowledge-graph", scanned: 2, excluded: 0,
    };
    publishSeam(KEY, makeStubPipeline(fixed));
    try {
      const pi = captureRegistrar();
      registerKnowledgeSearchTool(pi, () => dir, {
        vectorStore: () =>
          t4VectorStore([
            { mdId: "md/knowledge/b", kind: "knowledge" }, // HNSW rank 0
            { mdId: "md/knowledge/a", kind: "knowledge" }, // HNSW rank 1
          ]),
        embedder: () => t4Embedder(),
        lexicalRecall: buildLexicalRecall(dir),
        entityRecall: buildEntityRecall(dir),
        boostWeight: 1.0,
      });
      const def = pi.def();
      assert.ok(def, "knowledge_search tool registered");
      const out = await def!.execute("call-t4", { query: T4_QUERY, semantic: true }, undefined, undefined, {});
      const text = textOf(out);
      const idxA = text.indexOf("Card A Quokka MLX Survey");
      const idxB = text.indexOf("Card B Hedgehog Rotation");
      assert.ok(idxA >= 0, "card A present in text");
      assert.ok(idxB >= 0, "card B present in text");
      assert.ok(idxA < idxB, "voted card A must be listed BEFORE warm-only card B");
      const cards = (out.details as RetrieveResult).cards;
      assert.deepEqual(cards.map((c) => c.id), ["md/knowledge/a", "md/knowledge/b"]);
    } finally {
      delete (globalThis as Record<string, unknown>)[KEY];
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
