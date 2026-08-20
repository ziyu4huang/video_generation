import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createCardStore } from "../src/store/card-store.js";
import { KnowledgeSerializer } from "../src/store/knowledge-serializer.js";
import type { Card } from "../src/store/card.js";

const here = dirname(fileURLToPath(import.meta.url));
// Named "corpus" (not "vault") to avoid the repo-wide `.gitignore` `vault/`
// rule (the auto-generated obsidian vault). Committed copies of REAL vault-md
// cards (lever/gotcha/pattern/metric) + one non-zettel file the serializer
// must skip. Mirrors `vaults_root/s2-agent-vault/Zettelkasten/knowledge-graph/`.
const vaultDir = join(here, "__fixtures__/corpus");

/** Deserialize every `.md` in the fixture corpus into Cards. Non-zettel files
 *  yield `[]` from the serializer and contribute nothing. */
function readCorpus(): Card[] {
  const ser = new KnowledgeSerializer();
  const files = readdirSync(vaultDir).filter((f) => f.endsWith(".md"));
  return files.flatMap((f) => ser.deserialize(readFileSync(join(vaultDir, f), "utf8"), { filePath: f }));
}

describe("knowledge corpus round-trip (acceptance — 06a task 6)", () => {
  // The corpus has 4 valid zettel cards + 1 non-zettel file (skipped → []).
  // The expected canonical ids, keyed for round-trip assertions.
  const expectedIds = new Set([
    "gui-review:extract-shared-helper-eliminates-duplication-class",
    "argparse-integrity:arg-registered-uses-private-actions",
    "auto-memory:argparse-sentinel-for-user-override",
    "gui-selfimprove:review-finds-skewed-low-severity",
  ]);

  let dbDir: string;
  let store: ReturnType<typeof createCardStore>;

  before(async () => {
    dbDir = mkdtempSync(join(tmpdir(), "corpus-"));
    store = await createCardStore({ memoryDir: dbDir, dbBackend: "sqlite" });
  });

  after(async () => {
    await store.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("the non-zettel fixture file is skipped by the serializer (returns [])", () => {
    const ser = new KnowledgeSerializer();
    const malformed = readFileSync(join(vaultDir, "adaptAutoMemoryMarkdown.md"), "utf8");
    assert.deepEqual(ser.deserialize(malformed, { filePath: "adaptAutoMemoryMarkdown.md" }), []);
  });

  it("ingests the corpus, retrieves it, preserves id/kind/content/frontmatter", async () => {
    const cards = readCorpus();
    // ≥3 valid cards; exactly the 4 expected (the non-zettel contributes 0).
    assert.ok(cards.length >= 3, `expected ≥3 valid cards, got ${cards.length}`);
    assert.equal(cards.length, 4, "the 4 zettel fixtures parse; the non-zettel is skipped");
    for (const id of expectedIds) {
      assert.ok(cards.some((c) => c.id === id), `expected canonical id missing from corpus: ${id}`);
    }

    for (const card of cards) {
      await store.upsertCard(card);
    }

    const all = await store.getCardsByKind("knowledge");
    assert.equal(all.length, cards.length, "every ingested card is retrievable by kind");

    for (const c of all) {
      assert.equal(c.kind, "knowledge");
      assert.ok(c.id);
      assert.ok(c.content.length > 0, "content (## 核心想法 body) must be non-empty");
      assert.ok(c.frontmatter && typeof c.frontmatter === "object");
      // Round-trip the kind-specific metadata envelope (record_type + confidence
      // are the load-bearing zettel frontmatter keys).
      assert.equal(c.frontmatter.id, c.id, "frontmatter.id must equal Card.id after round-trip");
      assert.ok(["lever", "gotcha", "pattern", "metric"].includes(String(c.frontmatter.record_type)));
      assert.equal(typeof c.frontmatter.confidence, "number");
    }

    // Per-card byte-exact content round-trip through SQLite.
    for (const original of cards) {
      const back = await store.getCard(original.id);
      assert.ok(back, `getCard missed id ${original.id}`);
      assert.equal(back!.content, original.content, `content drifted for ${original.id}`);
      assert.equal(back!.frontmatter.record_type, original.frontmatter.record_type);
      assert.equal(back!.frontmatter.confidence, original.frontmatter.confidence);
    }
  });

  it("re-ingesting the whole corpus is fully idempotent (no duplicate rows)", async () => {
    const cards = readCorpus();
    // First pass already ingested in the previous test (shared store); ingest
    // every card AGAIN and assert the row count is unchanged.
    const before = (await store.getCardsByKind("knowledge")).length;
    for (const c of cards) {
      await store.upsertCard(c);
      await store.upsertCard(c); // double-ingest each, for good measure
    }
    const after = (await store.getCardsByKind("knowledge")).length;
    assert.equal(after, before, "re-ingest must not create duplicate rows (KnowledgeDedupStrategy skip-on-id)");
    assert.equal(after, cards.length, "total rows still equals the corpus size");
    // No id appears more than once.
    const all = await store.getCardsByKind("knowledge");
    const ids = all.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, "every retrieved id is unique");
  });
});
