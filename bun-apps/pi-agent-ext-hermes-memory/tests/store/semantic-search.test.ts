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
import type { KnowledgePipeline, RetrieveResult } from "@repo/pi-agent-ext-core-interface";
import type { MemoryRepository, MemoryEntry } from "../../src/store/repository.js";

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
