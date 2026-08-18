// src/handlers/vector-backfill.test.ts — delta-keyed HNSW backfill tests.
// Mirrors planning-backfill's discipline: an injected inline `setTimeout` drives
// the deferred task synchronously so the test can await the (already resolved)
// state.promise without real timers; a fake embedder + mock stores; NO live
// SurrealDB / LM Studio. Covers the es1 entity-augment A/B matrix (seam leaf
// present/absent × summary present/empty) and the modelVersion lineage delta
// (unchanged card + bumped lineage tag → re-embed).
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  scheduleVectorBackfill,
  createVectorBackfillState,
  type VectorBackfillCardStore,
  type VectorBackfillVectorStore,
} from "./vector-backfill.js";
import type { CardKind } from "../store/card.js";
import { DEFAULT_EMBED_MODEL_VERSION } from "../constants.js";
import type { Embedder } from "@repo/pi-agent-core-interface";

const KEY = "__piKnowledgePipeline";
// Kind value is opaque to these tests (the mock store ignores it).
const KINDS = ["knowledge"] as unknown as CardKind[];

/** The zk leaf contract (entity-summary.ts augmentEmbedText): empty/absent
 *  summary → base; else (summary.slice(0,200) + " " + base).slice(0,1000). */
function zkContractLeaf(base: string, summary?: string | null): string {
  if (!summary || summary.length === 0) return base;
  return `${summary.slice(0, 200)} ${base}`.slice(0, 1000);
}

function mockCardStore(cards: unknown[]): VectorBackfillCardStore {
  return { getCardsByKind: async () => cards } as unknown as VectorBackfillCardStore;
}

/** Mock vector store: per-modelVersion mdId→contentHash maps (the delta-key
 *  namespace), so a modelVersion bump leaves old rows in place — exactly the
 *  production semantics the lineage delta relies on. */
function mockVectorStore() {
  const byModel = new Map<string, Map<string, string>>();
  let upserts = 0;
  const store = {
    getStoredHashes: async (modelVersion: string) => byModel.get(modelVersion) ?? new Map<string, string>(),
    upsertVectors: async (entries: Array<{ mdId: string; contentHash: string; modelVersion: string }>) => {
      upserts++;
      for (const e of entries) {
        let m = byModel.get(e.modelVersion);
        if (!m) {
          m = new Map<string, string>();
          byModel.set(e.modelVersion, m);
        }
        m.set(e.mdId, e.contentHash);
      }
    },
  } as unknown as VectorBackfillVectorStore;
  return { store, upsertCount: () => upserts };
}

function capturingEmbedder() {
  const embedTexts: string[][] = [];
  const embedder: Embedder = async (texts: string[], _model: string) => {
    embedTexts.push(texts);
    return texts.map(() => [0.1, 0.2]);
  };
  return { embedTexts, embedder };
}

const flush = (cb: () => void) => cb(); // run the deferred task inline

async function runBackfill(
  cards: unknown[],
  modelVersion: string,
  embedder: Embedder,
  vectorStore: VectorBackfillVectorStore,
): Promise<void> {
  const state = createVectorBackfillState();
  scheduleVectorBackfill(mockCardStore(cards), vectorStore, embedder, KINDS, modelVersion, "embed-model", {
    state,
    setTimeoutFn: flush as never,
  });
  await state.promise;
}

const cardWithSummary = {
  id: "kc:alpha",
  kind: "knowledge",
  frontmatter: { title: "Alpha Card", tags: ["proj", "ml"], entity_summary: "Alpha entity summary." },
  content: "Alpha body text.",
};
const cardEmptySummary = {
  id: "kc:beta",
  kind: "knowledge",
  frontmatter: { title: "Beta Card", tags: ["ops"], entity_summary: "   " },
  content: "Beta body text.",
};

describe("scheduleVectorBackfill — es1 entity-augment (seam leaf)", () => {
  it("seam present + entity summary → augmented embed text (≠ raw); empty summary → raw", async () => {
    const g = globalThis as Record<string, unknown>;
    g[KEY] = { entityAugment: { augmentEmbedText: zkContractLeaf } };
    try {
      const { embedTexts, embedder } = capturingEmbedder();
      const vs = mockVectorStore();
      await runBackfill([cardWithSummary, cardEmptySummary], "mv-augmented", embedder, vs.store);
      const [augA, augB] = embedTexts[0]!;
      // Body wrapped via the leaf: summary prefix + body.
      assert.equal(augA, "Alpha Card proj ml Alpha entity summary. Alpha body text.");
      // Whitespace-only entity_summary trims to empty → raw body (leaf not applied).
      assert.equal(augB, "Beta Card ops Beta body text.");
      assert.notEqual(augA, "Alpha Card proj ml Alpha body text.", "augmented must differ from raw");
    } finally {
      delete g[KEY];
    }
  });

  it("seam absent → byte-identical raw embed texts (even with a summary present)", async () => {
    const g = globalThis as Record<string, unknown>;
    delete g[KEY];
    const { embedTexts, embedder } = capturingEmbedder();
    const vs = mockVectorStore();
    await runBackfill([cardWithSummary, cardEmptySummary], "mv-raw", embedder, vs.store);
    const [rawA, rawB] = embedTexts[0]!;
    assert.equal(rawA, "Alpha Card proj ml Alpha body text.");
    assert.equal(rawB, "Beta Card ops Beta body text.");
  });
});

describe("scheduleVectorBackfill — es1 modelVersion lineage delta", () => {
  it("unchanged card: same modelVersion → no re-embed; bumped modelVersion → re-embeds", async () => {
    const g = globalThis as Record<string, unknown>;
    delete g[KEY]; // delta behavior is augment-independent
    const card = {
      id: "kc:stable",
      kind: "knowledge",
      frontmatter: { title: "Stable" },
      content: "stable body",
    };
    const vs = mockVectorStore();
    const { embedTexts, embedder } = capturingEmbedder();

    // Run 1 (old lineage tag): cold → embedded once.
    await runBackfill([card], "nomic-embed-text-v1.5", embedder, vs.store);
    assert.equal(embedTexts.length, 1);

    // Run 2 (same lineage, unchanged card): stored hash matches → no re-embed.
    await runBackfill([card], "nomic-embed-text-v1.5", embedder, vs.store);
    assert.equal(embedTexts.length, 1, "unchanged card must NOT re-embed");

    // Run 3 (bumped lineage tag — the es1 default): new delta-key namespace → re-embed.
    await runBackfill([card], DEFAULT_EMBED_MODEL_VERSION, embedder, vs.store);
    assert.equal(embedTexts.length, 2, "bumped modelVersion must re-embed unchanged cards");
    assert.ok(vs.upsertCount() >= 2);
  });

  it("es1 lineage bump is the default modelVersion", () => {
    assert.equal(DEFAULT_EMBED_MODEL_VERSION, "nomic-embed-text-v1.5+es1");
  });
});
