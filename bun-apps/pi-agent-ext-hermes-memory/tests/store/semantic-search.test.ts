/**
 * tests/store/semantic-search.test.ts — T2 warm path + T5(a) graceful
 * degradation for `searchSemantic` (ticket 14 phase A).
 *
 * Pure unit tests — NO live SurrealDB / LM Studio. Every dependency is an
 * injectable mock: VectorStore, Embedder, KnowledgePipeline, MemoryRepository.
 *
 * Covers:
 *   (a) WARM PATH — a populated VectorStore returns canned knn hits →
 *       searchSemantic returns them ranked, source "hnsw". No fallback invoked.
 *   (b) T5(a) KNOWLEDGE DEGRADE — vectorStore.knn THROWS → kp.retrieveRecords
 *       is called with semantic:true (zk cosine fallback). No throw, results.
 *   (c) T5(a) MEMORY DEGRADE — vectorStore.knn THROWS + kind=memory →
 *       memoryRepo.searchMemories is called (lexical FTS). No throw, results.
 *   (d) EMBED-NULL DEGRADE — embedder returns null (LM Studio down) → warm path
 *       skipped → memory fallback.
 *   (e) NO VECTORSTORE — undefined store → straight to fallback.
 *   (f) NEVER THROWS — even when every dependency throws, searchSemantic
 *       resolves to [] (the core T5(a) invariant).
 */

import { describe, it, expect, mock } from "bun:test";
import { searchSemantic, type SemanticSearchHit } from "../../src/store/semantic-search.js";
import type { VectorStore, VectorKnnHit } from "../../src/store/surreal/vector-store.js";
import type { Embedder } from "../../src/store/surreal/embedder.js";
import type { KnowledgePipeline, RetrieveResult } from "@repo/pi-agent-core-interface";
import type { MemoryRepository, MemoryEntry } from "../../src/store/repository.js";
import { upsertCachedCardVectors } from "../../src/store/card-vectors-cache.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EVEC: number[] = [1, 0, 0]; // the canned embedded query vector

function fakeEmbedder(): Embedder {
  return mock(async (_texts: string[], _model: string) => [EVEC]) as unknown as Embedder;
}

function throwingEmbedder(): Embedder {
  return mock(async () => { throw new Error("LM Studio down"); }) as unknown as Embedder;
}

function fakeVectorStore(knnResult: VectorKnnHit[]): VectorStore {
  return {
    init: mock(async () => {}),
    upsertVectors: mock(async () => {}),
    knn: mock(async () => knnResult),
    missingMdIds: mock(async () => []),
  };
}

function throwingVectorStore(): VectorStore {
  return {
    init: mock(async () => {}),
    upsertVectors: mock(async () => {}),
    knn: mock(async () => { throw new Error("SurrealDB down"); }),
    missingMdIds: mock(async () => []),
  };
}

const kpRetrieve = mock(async (): Promise<RetrieveResult> => ({
  count: 2,
  cards: [
    { id: "card-a", title: "Card A", detail: "d", tags: ["t"] },
    { id: "card-b", title: "Card B", detail: "d", tags: ["t"] },
  ],
  digest: "", folder: "kg", scanned: 10, excluded: 0,
}));

function fakeKp(): KnowledgePipeline {
  return { retrieveRecords: kpRetrieve } as unknown as KnowledgePipeline;
}

function fakeMemoryRepo(rows: MemoryEntry[]): Pick<MemoryRepository, "searchMemories"> {
  return { searchMemories: mock(async () => rows) };
}

describe("searchSemantic — warm path (T2)", () => {
  it("returns HNSW hits ranked when the vector store answers", async () => {
    const vs = fakeVectorStore([
      { mdId: "m1", kind: "memory" },
      { mdId: "m2", kind: "knowledge" },
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "memory", topK: 5, ef: 100,
      embedder: fakeEmbedder(), vectorStore: vs,
    });
    // kind=memory filter keeps only m1 (the store said m2 is knowledge).
    expect(hits).toEqual<SemanticSearchHit[]>([
      { mdId: "m1", kind: "memory", source: "hnsw" },
    ]);
  });

  it("respects excludeIds on the warm path", async () => {
    const vs = fakeVectorStore([{ mdId: "m1", kind: "memory" }, { mdId: "m2", kind: "memory" }]);
    const hits = await searchSemantic({
      queryText: "probe", topK: 5, embedder: fakeEmbedder(), vectorStore: vs,
      excludeIds: ["m1"],
    });
    expect(hits.map((h) => h.mdId)).toEqual(["m2"]);
  });

  it("surfaces contentHash on the warm path when knn provides it (Task 1)", async () => {
    const vs = fakeVectorStore([
      { mdId: "m1", kind: "memory", contentHash: "hash-1" },
      { mdId: "m2", kind: "memory" }, // hashless knn row → hit stays shape-compatible
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "memory", topK: 5, ef: 100,
      embedder: fakeEmbedder(), vectorStore: vs,
    });
    expect(hits).toEqual<SemanticSearchHit[]>([
      { mdId: "m1", kind: "memory", source: "hnsw", contentHash: "hash-1" },
      { mdId: "m2", kind: "memory", source: "hnsw" }, // no contentHash key
    ]);
  });

  it("does NOT invoke the fallback when the warm path answers []", async () => {
    const vs = fakeVectorStore([]); // warm path answers empty (legit no-match)
    const kp = fakeKp();
    const hits = await searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs, kp, vaultPath: "/v",
    });
    expect(hits).toEqual([]); // warm [] is returned, NOT fallen through
    expect(kpRetrieve).not.toHaveBeenCalled();
  });
});

describe("searchSemantic — T5(a) graceful degrade", () => {
  it("knowledge kind: knn THROWS → kp.retrieveRecords({semantic:true}) fallback", async () => {
    kpRetrieve.mockClear();
    const vs = throwingVectorStore();
    const hits = await searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs, kp: fakeKp(), vaultPath: "/v", folder: "kg",
    });
    expect(kpRetrieve).toHaveBeenCalledTimes(1);
    expect(hits.map((h) => h.mdId)).toEqual(["card-a", "card-b"]);
    expect(hits.every((h) => h.source === "zk-semantic")).toBe(true);
  });

  it("memory kind: knn THROWS → memoryRepo.searchMemories fallback", async () => {
    const vs = throwingVectorStore();
    const repo = fakeMemoryRepo([
      { id: 1, mdId: "mem-1", content: "c" } as MemoryEntry,
      { id: 2, content: "no mdId" } as MemoryEntry, // skipped (no stable id)
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "memory", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs, memoryRepo: repo,
    });
    expect(hits).toEqual<SemanticSearchHit[]>([
      { mdId: "mem-1", kind: "memory", source: "memory-lexical" },
    ]);
  });

  it("embedder returns null (LM Studio down) → warm path skipped, memory fallback", async () => {
    // An embedder that resolves null via embedQuery: embedQuery swallows a throw
    // → null. Use a throwing embedder to simulate embed failure.
    const vs = fakeVectorStore([{ mdId: "m1", kind: "memory" }]);
    const repo = fakeMemoryRepo([{ id: 1, mdId: "mem-1", content: "c" } as MemoryEntry]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "memory", topK: 5,
      embedder: throwingEmbedder(), vectorStore: vs, memoryRepo: repo,
    });
    // Warm path never answered (embed threw) → memory lexical fallback.
    expect(hits.map((h) => h.mdId)).toEqual(["mem-1"]);
    expect(hits.every((h) => h.source === "memory-lexical")).toBe(true);
  });

  it("no vectorStore wired → straight to fallback (knowledge)", async () => {
    kpRetrieve.mockClear();
    const hits = await searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 5,
      kp: fakeKp(), vaultPath: "/v",
    });
    expect(kpRetrieve).toHaveBeenCalledTimes(1);
    expect(hits.map((h) => h.mdId)).toEqual(["card-a", "card-b"]);
  });

  it("NEVER throws — every dependency throwing resolves to []", async () => {
    const vs = throwingVectorStore();
    // memory kind + throwing repo + no kp → all paths fail → [].
    const throwingRepo = { searchMemories: mock(async () => { throw new Error("fts down"); }) };
    const hits = await searchSemantic({
      queryText: "probe", kind: "memory", topK: 5,
      embedder: throwingEmbedder(), vectorStore: vs, memoryRepo: throwingRepo,
    });
    expect(hits).toEqual([]);
  });

  it("knowledge fallback with no kp → [] (graceful, no throw)", async () => {
    const vs = throwingVectorStore();
    const hits = await searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs, // no kp, no vaultPath
    });
    expect(hits).toEqual([]);
  });
});

describe("searchSemantic — contentHash dedup seam (ticket 19 T2)", () => {
  it("WARM: two knn hits sharing a contentHash collapse to one (keeps first)", async () => {
    // Two cards with the SAME contentHash but different mdIds both survive
    // mdId-dedup → the contentHash-dedup pass must collapse the pair to the
    // first occurrence (m1); a third card with a distinct hash is kept.
    const vs = fakeVectorStore([
      { mdId: "m1", kind: "memory", contentHash: "dup" },
      { mdId: "m2", kind: "memory", contentHash: "dup" },
      { mdId: "m3", kind: "memory", contentHash: "unique" },
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "memory", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs,
    });
    expect(hits).toEqual<SemanticSearchHit[]>([
      { mdId: "m1", kind: "memory", source: "hnsw", contentHash: "dup" },
      { mdId: "m3", kind: "memory", source: "hnsw", contentHash: "unique" },
    ]);
  });

  it("WARM: hashless hits are all kept (no contentHash is never a dedup key)", async () => {
    const vs = fakeVectorStore([
      { mdId: "m1", kind: "memory" },
      { mdId: "m2", kind: "memory" },
      { mdId: "m3", kind: "memory" },
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "memory", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs,
    });
    expect(hits.map((h) => h.mdId)).toEqual(["m1", "m2", "m3"]);
  });

  it("WARM: a hashed hit dedups against a later same-hash hit, hashless ones untouched", async () => {
    const vs = fakeVectorStore([
      { mdId: "m1", kind: "memory", contentHash: "x" },
      { mdId: "m2", kind: "memory" }, // hashless → always kept
      { mdId: "m3", kind: "memory", contentHash: "x" }, // dup of m1 → dropped
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "memory", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs,
    });
    expect(hits.map((h) => h.mdId)).toEqual(["m1", "m2"]);
  });

  it("COLD knowledge: hashless hits survive the dedup seam (correct no-op), no throw", async () => {
    // Cold-path hits carry NO contentHash → the dedup seam runs but is a
    // correct NO-OP: every hashless hit is kept (nothing collapses). The
    // meaningful collapse case lives on the WARM path (test above).
    const vs = throwingVectorStore();
    const hits = await searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs, kp: fakeKp(), vaultPath: "/v", folder: "kg",
    });
    expect(hits).toEqual<SemanticSearchHit[]>([
      { mdId: "card-a", kind: "knowledge", source: "zk-semantic" },
      { mdId: "card-b", kind: "knowledge", source: "zk-semantic" },
    ]);
  });

  it("COLD memory: hashless hits survive the dedup seam (correct no-op), no throw", async () => {
    const vs = throwingVectorStore();
    const repo = fakeMemoryRepo([
      { id: 1, mdId: "mem-1", content: "c" } as MemoryEntry,
      { id: 2, mdId: "mem-2", content: "c" } as MemoryEntry,
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "memory", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs, memoryRepo: repo,
    });
    expect(hits).toEqual<SemanticSearchHit[]>([
      { mdId: "mem-1", kind: "memory", source: "memory-lexical" },
      { mdId: "mem-2", kind: "memory", source: "memory-lexical" },
    ]);
  });

  it("NEVER THROWS: empty warm result → dedup seam runs on [] → [] (no throw)", async () => {
    const vs = fakeVectorStore([]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "memory", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs,
    });
    expect(hits).toEqual([]);
  });

  it("NEVER THROWS: cold path with no dependencies → [] through the dedup seam", async () => {
    // knowledge fallback with no kp → [] ; the dedup seam still runs on [].
    const vs = throwingVectorStore();
    const hits = await searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs, // no kp, no vaultPath
    });
    expect(hits).toEqual([]);
  });
});

describe("searchSemantic — Phase B cold-index backfill trigger", () => {
  it("fires scheduleVectorBackfill fire-and-forget when the warm path returns EMPTY", async () => {
    // Warm store answers with NO hits (cold-index signal) → trigger fires once,
    // the (empty) result is returned unchanged, and the trigger is NOT awaited.
    const vs = fakeVectorStore([]);
    const trigger = mock(() => {});
    const hits = await searchSemantic({
      queryText: "probe", kind: "memory", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs,
      scheduleVectorBackfill: trigger,
    });
    expect(hits).toEqual([]); // warm path answered [] (no fallthrough)
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire the trigger when the warm path returns hits", async () => {
    const vs = fakeVectorStore([{ mdId: "m1", kind: "memory" }]);
    const trigger = mock(() => {});
    const hits = await searchSemantic({
      queryText: "probe", kind: "memory", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs,
      scheduleVectorBackfill: trigger,
    });
    expect(hits.map((h) => h.mdId)).toEqual(["m1"]);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("never lets a throwing trigger affect the result (best-effort)", async () => {
    const vs = fakeVectorStore([]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "memory", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs,
      scheduleVectorBackfill: mock(() => { throw new Error("trigger boom"); }),
    });
    expect(hits).toEqual([]);
  });
});

describe("searchSemantic — survivingK cap (ticket 19 T3)", () => {
  it("WARM: caps the post-dedup ranked list to survivingK", async () => {
    // 5 distinct-contentHash knn hits (no dedup collapse) exceed survivingK 3.
    const vs = fakeVectorStore([
      { mdId: "m1", kind: "memory", contentHash: "h1" },
      { mdId: "m2", kind: "memory", contentHash: "h2" },
      { mdId: "m3", kind: "memory", contentHash: "h3" },
      { mdId: "m4", kind: "memory", contentHash: "h4" },
      { mdId: "m5", kind: "memory", contentHash: "h5" },
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "memory", topK: 10,
      embedder: fakeEmbedder(), vectorStore: vs,
      survivingK: 3,
    });
    expect(hits).toEqual<SemanticSearchHit[]>([
      { mdId: "m1", kind: "memory", source: "hnsw", contentHash: "h1" },
      { mdId: "m2", kind: "memory", source: "hnsw", contentHash: "h2" },
      { mdId: "m3", kind: "memory", source: "hnsw", contentHash: "h3" },
    ]);
  });

  it("WARM: defaults survivingK to topK when unset (no extra cap beyond topK)", async () => {
    // topK 4 with 5 distinct-hash hits → ranked stops at 4; survivingK unset → no cap.
    const vs = fakeVectorStore([
      { mdId: "m1", kind: "memory", contentHash: "h1" },
      { mdId: "m2", kind: "memory", contentHash: "h2" },
      { mdId: "m3", kind: "memory", contentHash: "h3" },
      { mdId: "m4", kind: "memory", contentHash: "h4" },
      { mdId: "m5", kind: "memory", contentHash: "h5" },
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "memory", topK: 4,
      embedder: fakeEmbedder(), vectorStore: vs,
    });
    expect(hits.map((h) => h.mdId)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("WARM: survivingK caps AFTER dedup (dup hashes collapse first, then cap)", async () => {
    // 5 knn rows, only 3 distinct contentHashes → dedup leaves [m1,m3,m5] → cap 2.
    const vs = fakeVectorStore([
      { mdId: "m1", kind: "memory", contentHash: "h1" },
      { mdId: "m2", kind: "memory", contentHash: "h1" }, // dup of m1
      { mdId: "m3", kind: "memory", contentHash: "h2" },
      { mdId: "m4", kind: "memory", contentHash: "h2" }, // dup of m3
      { mdId: "m5", kind: "memory", contentHash: "h3" },
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "memory", topK: 10,
      embedder: fakeEmbedder(), vectorStore: vs,
      survivingK: 2,
    });
    expect(hits.map((h) => h.mdId)).toEqual(["m1", "m3"]); // dedup→[m1,m3,m5], cap→[m1,m3]
  });

  it("survivingK is a CAP not a refill: post-dedup shortfall is returned as-is", async () => {
    // Only 2 distinct-hash hits survive dedup; survivingK 5 → returns 2 (no over-fetch).
    const vs = fakeVectorStore([
      { mdId: "m1", kind: "memory", contentHash: "h1" },
      { mdId: "m2", kind: "memory", contentHash: "h1" }, // dup
      { mdId: "m3", kind: "memory", contentHash: "h2" },
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "memory", topK: 10,
      embedder: fakeEmbedder(), vectorStore: vs,
      survivingK: 5,
    });
    expect(hits.map((h) => h.mdId)).toEqual(["m1", "m3"]); // 2 < 5, no refill
  });

  it("COLD knowledge: survivingK caps the zk-semantic fallback", async () => {
    kpRetrieve.mockClear();
    const vs = throwingVectorStore();
    const hits = await searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 10,
      embedder: fakeEmbedder(), vectorStore: vs, kp: fakeKp(), vaultPath: "/v", folder: "kg",
      survivingK: 1,
    });
    expect(hits.map((h) => h.mdId)).toEqual(["card-a"]); // 2 cards → cap 1
  });

  it("COLD memory: survivingK caps the memory-lexical fallback", async () => {
    const vs = throwingVectorStore();
    const repo = fakeMemoryRepo([
      { id: 1, mdId: "mem-1", content: "c" } as MemoryEntry,
      { id: 2, mdId: "mem-2", content: "c" } as MemoryEntry,
      { id: 3, mdId: "mem-3", content: "c" } as MemoryEntry,
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "memory", topK: 10,
      embedder: fakeEmbedder(), vectorStore: vs, memoryRepo: repo,
      survivingK: 2,
    });
    expect(hits.map((h) => h.mdId)).toEqual(["mem-1", "mem-2"]); // 3 → cap 2
  });
});

describe("searchSemantic — fix wave (final review)", () => {
  describe("Fix 1: falsy contentHash treated as 'no key' (no over-collapse)", () => {
    it("WARM: two rows with contentHash=\"\" are BOTH returned (not collapsed)", async () => {
      // RED: today collapses to one (empty string treated as shared key)
      // GREEN: both returned (falsy hash = no key, always kept)
      const vs = fakeVectorStore([
        { mdId: "m1", kind: "memory", contentHash: "" },
        { mdId: "m2", kind: "memory", contentHash: "" },
      ]);
      const hits = await searchSemantic({
        queryText: "probe", kind: "memory", topK: 5,
        embedder: fakeEmbedder(), vectorStore: vs,
      });
      expect(hits.map((h) => h.mdId)).toEqual(["m1", "m2"]);
    });

    it("WARM: two rows with contentHash=null are BOTH returned (not collapsed)", async () => {
      // RED: today collapses to one (null treated as shared key)
      // GREEN: both returned (falsy hash = no key, always kept)
      const vs = fakeVectorStore([
        { mdId: "m1", kind: "memory", contentHash: null },
        { mdId: "m2", kind: "memory", contentHash: null },
      ]);
      const hits = await searchSemantic({
        queryText: "probe", kind: "memory", topK: 5,
        embedder: fakeEmbedder(), vectorStore: vs,
      });
      expect(hits.map((h) => h.mdId)).toEqual(["m1", "m2"]);
    });

    it("WARM: truthy contentHash still dedups (real hash collapse still works)", async () => {
      // Verify the fix doesn't break real hash deduplication
      const vs = fakeVectorStore([
        { mdId: "m1", kind: "memory", contentHash: "real-hash" },
        { mdId: "m2", kind: "memory", contentHash: "real-hash" },
      ]);
      const hits = await searchSemantic({
        queryText: "probe", kind: "memory", topK: 5,
        embedder: fakeEmbedder(), vectorStore: vs,
      });
      expect(hits.map((h) => h.mdId)).toEqual(["m1"]); // collapsed to first
    });

    it("WARM: toHit only sets contentHash when truthy (shape-compatible with hashless hits)", async () => {
      // Verify toHit truthy-set: null/"" knn rows yield hits with NO contentHash key
      const vs = fakeVectorStore([
        { mdId: "m1", kind: "memory", contentHash: "" },
        { mdId: "m2", kind: "memory", contentHash: null },
        { mdId: "m3", kind: "memory", contentHash: "real-hash" },
      ]);
      const hits = await searchSemantic({
        queryText: "probe", kind: "memory", topK: 5,
        embedder: fakeEmbedder(), vectorStore: vs,
      });
      expect(hits).toEqual<SemanticSearchHit[]>([
        { mdId: "m1", kind: "memory", source: "hnsw" }, // no contentHash key
        { mdId: "m2", kind: "memory", source: "hnsw" }, // no contentHash key
        { mdId: "m3", kind: "memory", source: "hnsw", contentHash: "real-hash" },
      ]);
    });
  });

  describe("Fix 2: clamp survivingK cap (JS slice footgun)", () => {
    it("survivingK: 0 returns [] (not drop-last behavior)", async () => {
      // RED: today `slice(0, 0)` = [], correct, but test documents the guard
      const vs = fakeVectorStore([
        { mdId: "m1", kind: "memory", contentHash: "h1" },
        { mdId: "m2", kind: "memory", contentHash: "h2" },
      ]);
      const hits = await searchSemantic({
        queryText: "probe", kind: "memory", topK: 5,
        embedder: fakeEmbedder(), vectorStore: vs,
        survivingK: 0,
      });
      expect(hits).toEqual([]);
    });

    it("survivingK: -1 returns [] (clamped, not drop-last)", async () => {
      // RED: today `slice(0, -1)` drops last element (JS semantics)
      // GREEN: clamped to 0, returns []
      const vs = fakeVectorStore([
        { mdId: "m1", kind: "memory", contentHash: "h1" },
        { mdId: "m2", kind: "memory", contentHash: "h2" },
        { mdId: "m3", kind: "memory", contentHash: "h3" },
      ]);
      const hits = await searchSemantic({
        queryText: "probe", kind: "memory", topK: 5,
        embedder: fakeEmbedder(), vectorStore: vs,
        survivingK: -1,
      });
      expect(hits).toEqual([]); // clamped to 0, not [m1,m2]
    });

    it("survivingK: -5 returns [] (clamped, not drop-last-5)", async () => {
      // Verify clamp works for larger negative values
      const vs = fakeVectorStore([
        { mdId: "m1", kind: "memory", contentHash: "h1" },
        { mdId: "m2", kind: "memory", contentHash: "h2" },
      ]);
      const hits = await searchSemantic({
        queryText: "probe", kind: "memory", topK: 5,
        embedder: fakeEmbedder(), vectorStore: vs,
        survivingK: -5,
      });
      expect(hits).toEqual([]); // clamped to 0
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ticket 03 P2-T5 — LeanRAG ③: relation-signature dedup (dedupByRelation).
// ─────────────────────────────────────────────────────────────────────────────

describe("searchSemantic — relation dedup (ticket 03 P2-T5 / LeanRAG ③)", () => {
  /** Stub for the warm-path batched graph-attach seam: mdIds → mdId→relations. */
  function fakeFetchRelations(
    entries: Record<string, Array<{ s: string; rel: string; o: string }>>,
  ): (mdIds: string[]) => Promise<Map<string, Array<{ s: string; rel: string; o: string }>>> {
    return async (mdIds: string[]) =>
      new Map(mdIds.flatMap((id) => (entries[id] !== undefined ? [[id, entries[id]] as const] : [])));
  }

  it("WARM: identical canonical signatures collapse to first (alias ref vs references)", async () => {
    // m1 and m2 carry the SAME canonical edge A→references→B, emitted with
    // different surface predicates ("ref" vs "references"). normalizeRelation
    // maps both onto "references" → identical signature → m2 collapses.
    const vs = fakeVectorStore([
      { mdId: "m1", kind: "knowledge" },
      { mdId: "m2", kind: "knowledge" },
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs,
      fetchRelations: fakeFetchRelations({
        m1: [{ s: "A", rel: "ref", o: "B" }],
        m2: [{ s: "a", rel: "references", o: "b" }], // case+alias variant
      }),
    });
    expect(hits.length).toBe(1);
    expect(hits[0].mdId).toBe("m1");
    expect(hits[0].relations).toEqual([{ s: "A", rel: "ref", o: "B" }]);
  });

  it("WARM: differing signatures are both kept (with relations attached)", async () => {
    const vs = fakeVectorStore([
      { mdId: "m1", kind: "knowledge" },
      { mdId: "m2", kind: "knowledge" },
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs,
      fetchRelations: fakeFetchRelations({
        m1: [{ s: "A", rel: "references", o: "B" }],
        m2: [{ s: "A", rel: "extends", o: "B" }],
      }),
    });
    expect(hits.map((h) => h.mdId)).toEqual(["m1", "m2"]);
    expect(hits[0].relations).toEqual([{ s: "A", rel: "references", o: "B" }]);
  });

  it("WARM: empty or absent relations NEVER collapse by this rule", async () => {
    // m1 has an empty relations array; m2 is absent from the fetch map
    // (card/graph missing → silent skip). Neither carries a signature → both kept.
    const vs = fakeVectorStore([
      { mdId: "m1", kind: "knowledge" },
      { mdId: "m2", kind: "knowledge" },
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs,
      fetchRelations: fakeFetchRelations({ m1: [] }),
    });
    expect(hits.map((h) => h.mdId)).toEqual(["m1", "m2"]);
    expect(hits[0].relations).toBeUndefined(); // empty array → not attached
  });

  it("WARM: malformed relation entries → null signature → kept, no throw", async () => {
    // Entries missing fields / non-objects are malformed: the whole signature
    // is null → the hit is kept and NOTHING throws.
    const vs = fakeVectorStore([
      { mdId: "m1", kind: "knowledge" },
      { mdId: "m2", kind: "knowledge" },
    ]);
    const malformed = [
      { s: "A", rel: "ref" }, // missing o
      null,
      42,
    ] as unknown as Array<{ s: string; rel: string; o: string }>;
    const hits = await searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs,
      fetchRelations: fakeFetchRelations({ m1: malformed, m2: malformed }),
    });
    expect(hits.map((h) => h.mdId)).toEqual(["m1", "m2"]); // no collapse, no throw
  });

  it("WARM: survivingK cap applied AFTER relation dedup", async () => {
    // 3 hits: m1+m2 share a signature (collapse), m3 differs. Dedup leaves
    // [m1, m3]; survivingK=1 caps to [m1] — cap AFTER dedup, not before.
    const vs = fakeVectorStore([
      { mdId: "m1", kind: "knowledge" },
      { mdId: "m2", kind: "knowledge" },
      { mdId: "m3", kind: "knowledge" },
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 5, survivingK: 1,
      embedder: fakeEmbedder(), vectorStore: vs,
      fetchRelations: fakeFetchRelations({
        m1: [{ s: "A", rel: "references", o: "B" }],
        m2: [{ s: "A", rel: "references", o: "B" }],
        m3: [{ s: "C", rel: "extends", o: "D" }],
      }),
    });
    expect(hits.map((h) => h.mdId)).toEqual(["m1"]);
  });

  it("WARM: relation dedup composes AFTER contentHash dedup (contentHash wins first)", async () => {
    // m1 drops via contentHash (dup with m0); among survivors, m2+m3 share a
    // relation signature → m3 also drops. Result: [m0, m2].
    const vs = fakeVectorStore([
      { mdId: "m0", kind: "knowledge", contentHash: "h" },
      { mdId: "m1", kind: "knowledge", contentHash: "h" },
      { mdId: "m2", kind: "knowledge" },
      { mdId: "m3", kind: "knowledge" },
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs,
      fetchRelations: fakeFetchRelations({
        m2: [{ s: "A", rel: "references", o: "B" }],
        m3: [{ s: "A", rel: "ref", o: "B" }],
      }),
    });
    expect(hits.map((h) => h.mdId)).toEqual(["m0", "m2"]);
  });

  it("NEVER THROWS: fetchRelations throwing → search succeeds, relations silently absent", async () => {
    const vs = fakeVectorStore([
      { mdId: "m1", kind: "knowledge" },
      { mdId: "m2", kind: "knowledge" },
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs,
      fetchRelations: async () => { throw new Error("sqlite read failed"); },
    });
    expect(hits.map((h) => h.mdId)).toEqual(["m1", "m2"]); // kept, no dedup key
    expect(hits[0].relations).toBeUndefined();
  });

  it("COLD: memory-lexical hits (no relations) survive the relation seam (no-op)", async () => {
    // Cold fallback hits carry no relations → null signature → all kept.
    // No new fetch machinery on the fallback path: fetchRelations is ignored.
    const vs = throwingVectorStore();
    const repo = fakeMemoryRepo([
      { id: 1, mdId: "mem-1", content: "c" } as MemoryEntry,
      { id: 2, mdId: "mem-2", content: "c" } as MemoryEntry,
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "memory", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs, memoryRepo: repo,
      fetchRelations: async () => { throw new Error("must not be called on cold path"); },
    });
    expect(hits.map((h) => h.mdId)).toEqual(["mem-1", "mem-2"]);
  });
});

// ── Ticket 20 T1: multi-signal frequency vote + injectable seams ──────────
// Vote formula (PINNED): final = (signalCount - 1) * boostWeight + bestRankScore
// where bestRankScore = max over signals containing the mdId of
// (1 - rank/(topK+1)), 0 when no signal contains it. signalCount = 1 (warm)
// + number of extra signals containing the mdId. Rank/membership only — no
// cross-signal score arithmetic (Global Constraint). Vote runs BEFORE
// fetchRelations + contentHash/relation dedup + survivingK cap.

describe("searchSemantic — multi-signal frequency vote (ticket 20 T1)", () => {
  it("(a) 2-signal card outranks a better-cosine 1-signal card (default boostWeight 1.0)", async () => {
    const vs = fakeVectorStore([
      { mdId: "strong", kind: "knowledge" }, // warm rank 0 (best cosine)
      { mdId: "voted", kind: "knowledge" },  // warm rank 1
    ]);
    const lexical = mock(async (_q: string, _k: number) => [{ mdId: "voted", rank: 0 }]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs,
      lexicalRecall: lexical,
    });
    // voted: (2-1)*1.0 + (1-0/6) = 2.0 ; strong: (1-1)*1.0 + 0 = 0
    expect(hits.map((h) => h.mdId)).toEqual(["voted", "strong"]);
    expect(hits[0].signalCount).toBe(2);
    expect(hits[1].signalCount).toBe(1);
    expect(lexical).toHaveBeenCalledTimes(1);
    expect(lexical).toHaveBeenCalledWith("probe", 5);
  });

  it("(b) NO seams → warm order unchanged, signalCount stays undefined", async () => {
    const vs = fakeVectorStore([{ mdId: "m1", kind: "memory" }, { mdId: "m2", kind: "memory" }]);
    const hits = await searchSemantic({
      queryText: "probe", topK: 5, embedder: fakeEmbedder(), vectorStore: vs,
    });
    expect(hits.map((h) => h.mdId)).toEqual(["m1", "m2"]);
    expect(hits.every((h) => h.signalCount === undefined)).toBe(true);
  });

  it("(c) lexicalRecall REJECTS → allSettled skips it, entityRecall still votes", async () => {
    const vs = fakeVectorStore([{ mdId: "m1", kind: "knowledge" }, { mdId: "m2", kind: "knowledge" }]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs,
      lexicalRecall: async (_q: string, _k: number): Promise<Array<{ mdId: string; rank: number }>> => {
        throw new Error("FTS down");
      },
      entityRecall: async (_q: string, _k: number) => [{ mdId: "m2", rank: 0 }],
    });
    expect(hits.map((h) => h.mdId)).toEqual(["m2", "m1"]);
    expect(hits[0].signalCount).toBe(2);
    expect(hits[1].signalCount).toBe(1);
  });

  it("(d) boostWeight tunes dominance: 0.1 → strong 1-extra-signal wins; 10 → weak 2-extra-signal wins", async () => {
    const vs = fakeVectorStore([
      { mdId: "strong", kind: "knowledge" }, // warm rank 0
      { mdId: "weak", kind: "knowledge" },   // warm rank 1
    ]);
    const make = (boostWeight: number) => searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 5, boostWeight,
      embedder: fakeEmbedder(), vectorStore: vs,
      lexicalRecall: async (_q: string, _k: number) => [{ mdId: "strong", rank: 0 }, { mdId: "weak", rank: 5 }],
      entityRecall: async (_q: string, _k: number) => [{ mdId: "weak", rank: 5 }],
    });
    // strong: 1*w + (1-0/6)=1 → w+1 ; weak: 2*w + (1-5/6)=1/6
    const low = await make(0.1);  // strong 1.1 vs weak 0.3667
    expect(low.map((h) => h.mdId)).toEqual(["strong", "weak"]);
    expect(low[0].signalCount).toBe(2);
    const high = await make(10); // strong 11 vs weak ≈20.17
    expect(high.map((h) => h.mdId)).toEqual(["weak", "strong"]);
    expect(high[0].signalCount).toBe(3);
  });

  it("(e) contentHash dedup keeps the highest-VOTED twin (2-signal twin survives)", async () => {
    const vs = fakeVectorStore([
      { mdId: "plain", kind: "knowledge", contentHash: "dup" }, // warm rank 0
      { mdId: "voted", kind: "knowledge", contentHash: "dup" }, // warm rank 1, hash twin
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs,
      lexicalRecall: async (_q: string, _k: number) => [{ mdId: "voted", rank: 0 }],
    });
    // Vote re-orders voted first → keep-first dedup keeps the voted twin.
    expect(hits.map((h) => h.mdId)).toEqual(["voted"]);
    expect(hits[0].signalCount).toBe(2);
  });

  it("(f) survivingK cap applied AFTER the vote (voted-first hits survive the cap)", async () => {
    const vs = fakeVectorStore([
      { mdId: "m1", kind: "knowledge" },
      { mdId: "m2", kind: "knowledge" },
      { mdId: "m3", kind: "knowledge" },
    ]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 5, survivingK: 2,
      embedder: fakeEmbedder(), vectorStore: vs,
      entityRecall: async (_q: string, _k: number) => [{ mdId: "m3", rank: 0 }],
    });
    expect(hits.map((h) => h.mdId)).toEqual(["m3", "m1"]); // m3 voted first, cap keeps 2
  });

  it("(g) EMPTY signal arrays → signalCount 1 everywhere, warm order preserved", async () => {
    const vs = fakeVectorStore([{ mdId: "m1", kind: "knowledge" }, { mdId: "m2", kind: "knowledge" }]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs,
      lexicalRecall: async (_q: string, _k: number) => [],
      entityRecall: async (_q: string, _k: number) => [],
    });
    expect(hits.map((h) => h.mdId)).toEqual(["m1", "m2"]);
    expect(hits.every((h) => h.signalCount === 1)).toBe(true);
  });

  it("(i) lexicalRecall mdId NOT among warm hits → no phantom hit invented, existing hits unaffected", async () => {
    const vs = fakeVectorStore([{ mdId: "m1", kind: "knowledge" }, { mdId: "m2", kind: "knowledge" }]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "knowledge", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs,
      lexicalRecall: async (_q: string, _k: number) => [{ mdId: "phantom", rank: 0 }],
    });
    expect(hits.length).toBe(2); // length unchanged — no phantom hit invented
    expect(hits.map((h) => h.mdId)).toEqual(["m1", "m2"]); // existing hits unaffected (warm order)
    expect(hits.every((h) => h.signalCount === 1)).toBe(true); // phantom vote counted for no one
  });

  it("(h) FALLBACK paths untouched: seams never consulted when knn throws", async () => {
    const vs = throwingVectorStore();
    const repo = fakeMemoryRepo([{ id: 1, mdId: "mem-1", content: "c" } as MemoryEntry]);
    const hits = await searchSemantic({
      queryText: "probe", kind: "memory", topK: 5,
      embedder: fakeEmbedder(), vectorStore: vs, memoryRepo: repo,
      lexicalRecall: async (): Promise<Array<{ mdId: string; rank: number }>> => {
        throw new Error("must not be called on the cold path");
      },
      entityRecall: async (): Promise<Array<{ mdId: string; rank: number }>> => {
        throw new Error("must not be called on the cold path");
      },
    });
    expect(hits.map((h) => h.mdId)).toEqual(["mem-1"]);
    expect(hits[0].signalCount).toBeUndefined(); // fallback hits never get signalCount
  });
});


describe("T5(b) hermes-cosine memory degrade (kp18 / hermes-arch 10)", () => {
  const mkDir = () => mkdtempSync(join(tmpdir(), "hermes-cosine-"));
  const lexRepo = () => {
    const searchMemories = mock(async () => [{ mdId: "md-lex" }] as never);
    return { searchMemories, repo: { searchMemories } as never };
  };

  it("knn-throw + embed OK + matching cache → hermes-cosine, similarity-ordered, lexical NOT called", async () => {
    const dir = mkDir();
    try {
      upsertCachedCardVectors(dir, [
        { mdId: "md-align", kind: "memory", embedModel: "m-test", contentHash: "h1", vec: [1, 0, 0] },
        { mdId: "md-orth", kind: "memory", embedModel: "m-test", contentHash: "h2", vec: [0, 1, 0] },
        { mdId: "md-k-kind", kind: "knowledge", embedModel: "m-test", contentHash: "h3", vec: [1, 0, 0] },
        { mdId: "md-model", kind: "memory", embedModel: "other", contentHash: "h4", vec: [1, 0, 0] },
      ]);
      const { searchMemories, repo } = lexRepo();
      const hits = await searchSemantic({
        queryText: "anything",
        kind: "memory",
        model: "m-test",
        embedder: fakeEmbedder(),
        vectorStore: throwingVectorStore(),
        memoryRepo: repo,
        memoryDir: dir,
        topK: 5,
      } as never);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.source === "hermes-cosine")).toBe(true);
      expect(hits.map((h) => h.mdId)).toEqual(["md-align", "md-orth"]);
      expect((searchMemories.mock.calls as unknown[][]).length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cache EMPTY → lexical floor unchanged", async () => {
    const dir = mkDir();
    try {
      const { repo } = lexRepo();
      const hits = await searchSemantic({
        queryText: "anything", kind: "memory", model: "m-test",
        embedder: fakeEmbedder(), vectorStore: throwingVectorStore(),
        memoryRepo: repo, memoryDir: dir, topK: 5,
      } as never);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].source).toBe("memory-lexical");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cache present but embedModel differs → lexical floor", async () => {
    const dir = mkDir();
    try {
      upsertCachedCardVectors(dir, [
        { mdId: "md-model", kind: "memory", embedModel: "other", contentHash: "h4", vec: [1, 0, 0] },
      ]);
      const { repo } = lexRepo();
      const hits = await searchSemantic({
        queryText: "anything", kind: "memory", model: "m-test",
        embedder: fakeEmbedder(), vectorStore: throwingVectorStore(),
        memoryRepo: repo, memoryDir: dir, topK: 5,
      } as never);
      expect(hits[0].source).toBe("memory-lexical");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("embed fails (LM Studio down) + cache present → lexical floor (no query vec → no cosine)", async () => {
    const dir = mkDir();
    try {
      upsertCachedCardVectors(dir, [
        { mdId: "md-align", kind: "memory", embedModel: "m-test", contentHash: "h1", vec: [1, 0, 0] },
      ]);
      const { repo } = lexRepo();
      const hits = await searchSemantic({
        queryText: "anything", kind: "memory", model: "m-test",
        embedder: throwingEmbedder(), vectorStore: throwingVectorStore(),
        memoryRepo: repo, memoryDir: dir, topK: 5,
      } as never);
      expect(hits[0].source).toBe("memory-lexical");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
