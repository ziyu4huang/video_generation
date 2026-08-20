import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SurrealBackend } from "../../../src/store/surreal/surreal-backend.js";
import { SurrealClient } from "../../../src/store/surreal/surreal-client.js";
import { SurrealMemoryRepository } from "../../../src/store/surreal/surreal-memory-repo.js";
import { SurrealSessionRepository } from "../../../src/store/surreal/surreal-session-repo.js";
import { SurrealVectorStore } from "../../../src/store/surreal/vector-store.js";
import { isSurrealUp } from "./_helpers.js";

// hermes-arch 09 close-out: lock the CURRENT down-path contracts with fully
// offline stubs — no live SurrealDB, no localDescribe. Every seam below gets
// a fetch that always rejects; maxAttempts:1 + backoffMs:1 keep it instant.

const deadFetch = (): Promise<Response> =>
  Promise.reject(new Error("connection refused downstream"));

function deadClient(): SurrealClient {
  return new SurrealClient({
    endpoint: "http://127.0.0.1:8000", namespace: "test", database: "test",
    username: "root", password: "root",
    fetch: deadFetch as unknown as typeof fetch,
    maxAttempts: 1, backoffMs: 1,
  });
}

function deadBackend(): SurrealBackend {
  const backend = new SurrealBackend({});
  // The backend ctor forwards only endpoint/ns/db/user/pass into its client,
  // so the injectable fetch seam lives one level down: swap the public
  // `client` for one wired to deadFetch (readonly is compile-time only).
  (backend as { client: SurrealClient }).client = deadClient();
  return backend;
}

describe("SurrealDB down-path contracts (hermes-arch 09, offline stubs)", () => {
  it("T1 backend healthCheck/init surface SurrealDB-down as a rejection (upstream fallback owns the catch)", async () => {
    // LOCKED current behavior: SurrealBackend.healthCheck() does NOT swallow —
    // it propagates the client's retry-then-throw marker. The degrade seam is
    // upstream (init WithFallback -> sqlite catches); this test pins that
    // healthCheck/init themselves reject deterministically, never hang, and
    // always carry the "SurrealDB request failed" marker for callers.
    const backend = deadBackend();
    await assert.rejects(backend.healthCheck(), /SurrealDB request failed/);
    await assert.rejects(backend.init(), /SurrealDB request failed/);
  });

  it("T2 memory-repo write rejects with the retry-then-throw marker", async () => {
    const repo = new SurrealMemoryRepository(deadBackend());
    await assert.rejects(
      repo.addMemory({ content: "down-path probe" }),
      /SurrealDB request failed/,
    );
  });

  it("T2b session-repo write rejects with the retry-then-throw marker", async () => {
    const repo = new SurrealSessionRepository(deadBackend());
    await assert.rejects(
      repo.markUsed("session:probe", ["md:probe"], "2026-08-16T00:00:00.000Z"),
      /SurrealDB request failed/,
    );
  });

  it("T3 vector-store upsert + knn reject with the failure marker", async () => {
    const store = new SurrealVectorStore(deadClient(), "test", "test");
    await assert.rejects(
      store.upsertVectors([
        { mdId: "md:probe", kind: "memory", modelVersion: "probe-v1", contentHash: "deadbeef", vec: [0.1, 0.2] },
      ]),
      /SurrealDB request failed/,
    );
    await assert.rejects(store.knn([0.1, 0.2], 3, 8), /SurrealDB request failed/);
  });

  it("T4 graph heal is best-effort never-throw (resolves even with SurrealDB down)", async () => {
    const repo = new SurrealMemoryRepository(deadBackend());
    const normalized = await repo.normalizeLegacyMemoryIds();
    const backfilled = await repo.backfillGraphEdges();
    assert.equal(typeof normalized, "number");
    assert.equal(typeof backfilled, "number");
  });

  it("T6 canary: isSurrealUp reports false fast for a dead endpoint", async () => {
    const t0 = Date.now();
    const up = await isSurrealUp("http://127.0.0.1:1");
    assert.equal(up, false);
    assert.ok(Date.now() - t0 < 3000, "canary must fail fast (<3s)");
  });

  // T5 (knowledge warm-probe) intentionally OMITTED: the tool-layer seam is
  // not importable-stubbable offline within the <=5-line budget. The
  // search-layer down contract is already locked by semantic-search.test.ts
  // ("NEVER throws — every dependency throwing resolves to []") and the
  // tool-layer catch{} warm-probe is covered by inspection; see ticket 09.
});
