/**
 * tests/walk-and-ingest-vector-backfill.test.ts — Phase B / T3 wiring: verifies
 * walkAndIngest fires the delta-keyed vector backfill best-effort after the
 * mirror steps WITHOUT blocking or breaking ingest.
 *
 * Uses a REAL temp SQLite cardStore (pre-populated with one knowledge card) +
 * a MOCK vectorStore (no live SurrealDB) + a FAKE embedder (no LM Studio). The
 * fire is fire-and-forget (async IIFE + real setTimeout(0)), so the test polls
 * the mock's upsert spy until the deferred task lands (bounded — deterministic
 * in practice: a handful of event-loop turns).
 */

import { describe, it, expect, mock } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { walkAndIngest } from "../src/walk-and-ingest.js";
import { createCardStore } from "../src/store/card-store.js";
import type { Card } from "../src/store/card.js";
import type { VectorStore, VectorUpsertEntry } from "../src/store/surreal/vector-store.js";
import type { Embedder } from "@repo/pi-agent-core-interface";
import { planningContentHash } from "../src/store/planning-sync-state.js";
import { waitForVectorBackfill } from "../src/handlers/vector-backfill.js";

const MODEL_VERSION = "nomic-embed-text-v1.5";
const EMBED_MODEL = "text-embedding-nomic-embed-text-v1.5";

/** Poll `fn()` until true or timeout (bounded — for the fire-and-forget task). */
async function pollUntil(fn: () => boolean, timeoutMs = 2000, stepMs = 5): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return fn();
}

describe("walkAndIngest — Phase B vector backfill wiring", () => {
  it("fires the delta-keyed backfill best-effort after ingest (never blocks/breaks)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "walk-ingest-vec-"));
    const memoryDir = path.join(tmp, "memory");
    try {
      // Pre-populate the cardStore with one knowledge card.
      const card: Card = {
        id: "k-1",
        kind: "knowledge",
        content: "MLX runs bf16 natively on Apple Silicon; no FP8.",
        frontmatter: { id: "k-1", title: "MLX bf16 native", tags: ["mlx", "apple-silicon"] },
      };
      {
        const store = await createCardStore({ memoryDir });
        await store.upsertCard(card);
        await store.close();
      }

      // Mock vectorStore (empty stored → the card is the full delta) + fake embedder.
      const upserts: VectorUpsertEntry[] = [];
      const vectorStore: Pick<VectorStore, "getStoredHashes" | "upsertVectors"> = {
        getStoredHashes: mock(async () => new Map<string, string>()),
        upsertVectors: mock(async (entries: VectorUpsertEntry[]) => {
          upserts.push(...entries);
        }),
      };
      const embedder: Embedder = mock(async (texts: string[]) =>
        texts.map((_, i) => [1, i, 0]),
      );

      // planningOnly + empty input → no zk path; the receipt is ok:false (no
      // seam + no planning source) BUT the vector backfill STILL fires (it is
      // independent of the receipt path). It must NEVER block ingest: the
      // receipt returns synchronously relative to the (deferred) backfill.
      const receipt = await walkAndIngest([], {
        memoryDir,
        planningOnly: true,
        vectorBackfill: { vectorStore, embedder, modelVersion: MODEL_VERSION, embedModel: EMBED_MODEL },
      });

      // Ingest returned a well-formed receipt regardless of the backfill.
      expect(receipt.ok).toBe(false); // no seam + no planning source
      expect(receipt.mirrored).toBe(0);

      // The fire-and-forget backfill lands within a bounded window.
      const landed = await pollUntil(() => upserts.length > 0);
      expect(landed).toBe(true);
      // Drain the deferred task fully (shutdown hygiene).
      await waitForVectorBackfill(2000);

      // The single knowledge card was embedded + upserted with the delta-key.
      expect(upserts).toHaveLength(1);
      expect(upserts[0]!.mdId).toBe("k-1");
      expect(upserts[0]!.kind).toBe("knowledge");
      expect(upserts[0]!.modelVersion).toBe(MODEL_VERSION);
      expect(upserts[0]!.contentHash).toBe(planningContentHash(card));
      expect(Array.isArray(upserts[0]!.vec)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not break ingest when the backfill deps throw (error-isolated)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "walk-ingest-vec-throw-"));
    const memoryDir = path.join(tmp, "memory");
    try {
      // A throwing embedder inside the deferred task — must NOT escape into ingest.
      const throwingEmbedder: Embedder = mock(async () => {
        throw new Error("LM Studio down");
      });
      const vectorStore: Pick<VectorStore, "getStoredHashes" | "upsertVectors"> = {
        getStoredHashes: mock(async () => new Map()),
        upsertVectors: mock(async () => {}),
      };

      const receipt = await walkAndIngest([], {
        memoryDir,
        planningOnly: true,
        vectorBackfill: {
          vectorStore,
          embedder: throwingEmbedder,
          modelVersion: MODEL_VERSION,
          embedModel: EMBED_MODEL,
        },
      });

      // Ingest is unaffected — the throw is isolated inside the deferred task.
      expect(receipt).toBeDefined();
      // Let the deferred task settle (it swallows + clears state).
      await waitForVectorBackfill(2000);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
