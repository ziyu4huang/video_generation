/**
 * tests/store/surreal/vector-store.test.ts — integration test for the
 * card_vectors HNSW side-table (ticket 14 phase A / T1).
 *
 * Gated by `isSurrealUp`: the full suite must stay deterministic offline, so
 * when the local SurrealDB is absent the whole block is skipped. When present,
 * it uses a throwaway ns/db (`bench_hnsw14_<pid>_<nonce>`) and REMOVES it after.
 *
 * Vectors are synthetic + seeded (mulberry32 + Box–Muller, ported from
 * bench/hnsw-vs-cosine.ts) — no LM Studio dependency, fully deterministic.
 *
 * Covers:
 *   - recall: a probe that is an EXACT copy of a planted vector (cosine 1.0)
 *     must be the knn top-1 (HNSW finds exact matches at ef=100 on 200 vecs).
 *   - idempotent upsert: re-upserting the same (mdId, modelVersion) set does
 *     NOT duplicate rows (deterministic record id is the uniqueness enforcer).
 *   - missingMdIds: the cold-set diff returns mdIds present in the query list
 *     but absent from card_vectors at the given modelVersion.
 *   - mock-client unit path: a fake client asserts upsert chunking + the knn /
 *     missingMdIds SQL shapes without touching SurrealDB.
 */

import { describe, it, expect, mock } from "bun:test";
import { SurrealClient } from "../../../src/store/surreal/surreal-client.js";
import {
  SurrealVectorStore,
  NoopVectorStore,
  type VectorUpsertEntry,
} from "../../../src/store/surreal/vector-store.js";
import { isSurrealUp, localDescribe, uniqueNs } from "./_helpers.js";

const DIM = 768;
const ENDPOINT = "http://127.0.0.1:8000";

// ── Seeded synthetic vectors (ported from bench/hnsw-vs-cosine.ts) ──────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** N synthetic DIM-dim unit vectors (Gaussian → L2-normalize), seeded. */
function genUnitVectors(n: number, seed: number): number[][] {
  const rng = mulberry32(seed);
  const out: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = new Array<number>(DIM);
    let norm = 0;
    for (let d = 0; d < DIM; d++) {
      const g = gaussian(rng);
      v[d] = g;
      norm += g * g;
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < DIM; d++) v[d] /= norm;
    out[i] = v;
  }
  return out;
}

function mdIdOf(i: number): string {
  return `mem_${String(i).padStart(4, "0")}`;
}

function entriesFrom(vectors: number[][], modelVersion: string): VectorUpsertEntry[] {
  return vectors.map((vec, i) => ({
    mdId: mdIdOf(i),
    kind: i % 2 === 0 ? "memory" : "knowledge",
    vec,
    contentHash: `hash_${i}`,
    modelVersion,
  }));
}

const up = await isSurrealUp(ENDPOINT);

localDescribe("SurrealVectorStore (live SurrealDB)", up, () => {
  it("knn recalls the exact-match nearest, upsert is idempotent, missingMdIds diffs the cold set", async () => {
    const ns = `bench_hnsw14_${process.pid}_${Date.now().toString(36)}`;
    const db = "vecs";
    const client = new SurrealClient({
      endpoint: ENDPOINT, namespace: ns, database: db,
      username: "root", password: "root", requestTimeoutMs: 30_000,
    });
    const store = new SurrealVectorStore(client, ns, db);
    try {
      const N = 200;
      const vectors = genUnitVectors(N, 0xc0ffee);
      const modelVersion = "nomic-embed-text-v1.5";

      // init() bootstraps ns/db + table + HNSW index (idempotent).
      await store.init();
      await store.init();

      // upsert N vectors (2 batches at VEC_BATCH=120).
      await store.upsertVectors(entriesFrom(vectors, modelVersion));

      // Idempotency: re-upsert the SAME set → row count unchanged.
      await store.upsertVectors(entriesFrom(vectors, modelVersion));
      const count = await client.query<Array<{ count: number }>>(
        "SELECT count() FROM card_vectors GROUP ALL;",
      );
      expect(count[0]?.count).toBe(N);

      // Recall: probe = exact copy of vectors[7] (cosine 1.0) → top-1 is mdId_0007.
      const probeIdx = 7;
      const probe = vectors[probeIdx]!;
      const hits = await store.knn(probe, 1, 100);
      expect(hits.length).toBe(1);
      expect(hits[0]!.mdId).toBe(mdIdOf(probeIdx));

      // missingMdIds: 50 ids absent from card_vectors + all present ones.
      const presentIds = Array.from({ length: N }, (_, i) => mdIdOf(i));
      const coldIds = Array.from({ length: 50 }, (_, i) => `cold_${i}`);
      const missing = await store.missingMdIds([...presentIds, ...coldIds], modelVersion);
      expect(new Set(missing)).toEqual(new Set(coldIds));

      // A different modelVersion reports ALL ids missing (cold for the new tag).
      const missingNewModel = await store.missingMdIds(presentIds, "a-new-model-v2");
      expect(new Set(missingNewModel)).toEqual(new Set(presentIds));
    } finally {
      try { await client.query(`REMOVE NAMESPACE IF EXISTS ${ns};`); } catch { /* best-effort */ }
    }
  });
});

// ── Mock-client unit path (no SurrealDB) ───────────────────────────────────

describe("SurrealVectorStore (mock client)", () => {
  // init() runs VECTOR_BOOTSTRAP_SQL (DEFINE…) with no params; the method
  // calls then issue the real query. Route by SQL content so the mock handles
  // both, and call store.init() up front so the per-method init() is a no-op.
  it("upsert chunks at VEC_BATCH and builds UPSERT statements with backtick record ids", async () => {
    const calls: string[] = [];
    const fakeClient = {
      async query<T>(sql: string, _params?: Record<string, unknown>): Promise<T> {
        calls.push(sql);
        return [] as unknown as T;
      },
    } as unknown as SurrealClient;
    const store = new SurrealVectorStore(fakeClient, "ns", "db");
    await store.init(); // bootstrap (1 DEFINE call); subsequent methods skip init.
    calls.length = 0;   // reset so only upsert calls are counted below.
    // 250 entries → ceil(250/120) = 3 upsert query calls.
    const entries: VectorUpsertEntry[] = Array.from({ length: 250 }, (_, i) => ({
      mdId: `m${i}`, kind: "memory", vec: [1, 0, 0], contentHash: `h${i}`, modelVersion: "mv1",
    }));
    await store.upsertVectors(entries);
    expect(calls.length).toBe(3);
    // First chunk has 120 UPSERT statements; each uses a backtick record id.
    const firstStmts = calls[0]!.split("\n");
    expect(firstStmts.length).toBe(120);
    expect(firstStmts[0]).toContain("UPSERT card_vectors:`m0__mv1`");
    expect(firstStmts[0]).toContain("vec = [1.000000,0.000000,0.000000]");
  });

  it("knn builds the 2-arg KNN SQL and maps rows to hits", async () => {
    const fakeClient = {
      async query<T>(sql: string, params?: Record<string, unknown>): Promise<T> {
        if (sql.includes("DEFINE")) return [] as unknown as T; // init
        expect(sql).toContain("vec <|5,100|> $q");
        expect(params).toEqual({ q: [1, 2, 3] });
        return [{ mdId: "m1", kind: "memory" }, { mdId: "m2", kind: "knowledge" }] as unknown as T;
      },
    } as unknown as SurrealClient;
    const store = new SurrealVectorStore(fakeClient, "ns", "db");
    await store.init();
    const hits = await store.knn([1, 2, 3], 5, 100);
    expect(hits).toEqual([
      { mdId: "m1", kind: "memory" },
      { mdId: "m2", kind: "knowledge" },
    ]);
  });

  it("missingMdIds diffs client-side against the stored set", async () => {
    const fakeClient = {
      async query<T>(sql: string, params?: Record<string, unknown>): Promise<T> {
        if (sql.includes("DEFINE")) return [] as unknown as T; // init
        expect(params).toEqual({ mv: "mv1" });
        return [{ mdId: "a" }, { mdId: "b" }] as unknown as T;
      },
    } as unknown as SurrealClient;
    const store = new SurrealVectorStore(fakeClient, "ns", "db");
    await store.init();
    const missing = await store.missingMdIds(["a", "b", "c", "d"], "mv1");
    expect(missing).toEqual(["c", "d"]);
  });

  it("getStoredHashes returns Map<mdId,contentHash> for the modelVersion (body-safe: hashes not vectors)", async () => {
    const fakeClient = {
      async query<T>(sql: string, params?: Record<string, unknown>): Promise<T> {
        if (sql.includes("DEFINE")) return [] as unknown as T; // init
        expect(sql).toContain("SELECT mdId, contentHash FROM card_vectors WHERE modelVersion = $mv");
        expect(params).toEqual({ mv: "mv1" });
        return [
          { mdId: "a", contentHash: "ha" },
          { mdId: "b", contentHash: "hb" },
        ] as unknown as T;
      },
    } as unknown as SurrealClient;
    const store = new SurrealVectorStore(fakeClient, "ns", "db");
    await store.init();
    const hashes = await store.getStoredHashes("mv1");
    expect(hashes).toBeInstanceOf(Map);
    expect(hashes.get("a")).toBe("ha");
    expect(hashes.get("b")).toBe("hb");
    expect(hashes.size).toBe(2);
  });
});

describe("NoopVectorStore", () => {
  it("is a graceful no-op / empty-result stub", async () => {
    const noop = new NoopVectorStore();
    await expect(noop.init()).resolves.toBeUndefined();
    await expect(noop.upsertVectors([])).resolves.toBeUndefined();
    await expect(noop.knn([1, 2, 3], 5, 100)).resolves.toEqual([]);
    await expect(noop.missingMdIds(["a"], "mv1")).resolves.toEqual([]);
    const hashes = await noop.getStoredHashes("mv1");
    expect(hashes).toBeInstanceOf(Map);
    expect(hashes.size).toBe(0);
  });
});
