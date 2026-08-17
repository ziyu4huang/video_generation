/**
 * tests/handlers/vector-backfill.test.ts — T3 background vector backfill
 * (ticket 14 phase B).
 *
 * Pure unit tests — NO live SurrealDB / LM Studio. Every dependency is an
 * injectable mock: cardStore (getCardsByKind), vectorStore (getStoredHashes /
 * upsertVectors), embedder, setTimeoutFn, state. Covers:
 *
 *   (a) DELTA-KEY — unchanged card (mdId+modelVersion+contentHash match) is NOT
 *       re-embedded; a card whose contentHash changed IS embedded once; a new
 *       card (absent from stored) IS embedded once.
 *   (b) ALL-UNCHANGED — every card current → embedder never called (no work).
 *   (c) BATCH CHUNKING — >EMBED_BATCH stale cards → embedder/upsert called once
 *       per batch (ceil(N/32)), each card embedded exactly once.
 *   (d) COALESCE — two concurrent scheduleVectorBackfill calls → the second
 *       returns false and only ONE deferred task runs.
 *   (e) ERROR ISOLATION — embedder/upsert throws → inProgress cleared, throw
 *       swallowed (best-effort notify), promise resolves (never rejects).
 *   (f) SHUTDOWN DRAIN — waitForVectorBackfill resolves true on completion,
 *       false on timeout.
 */

import { describe, it, expect, mock } from "bun:test";
import {
  scheduleVectorBackfill,
  waitForVectorBackfill,
  createVectorBackfillState,
  VECTOR_BACKFILL_EMBED_BATCH,
  type VectorBackfillCardStore,
  type VectorBackfillVectorStore,
  type VectorBackfillState,
} from "../../src/handlers/vector-backfill.js";
import type { Card, CardKind } from "../../src/store/card.js";
import type { Embedder } from "@repo/pi-agent-core-interface";
import type { VectorUpsertEntry } from "../../src/store/surreal/vector-store.js";
import { planningContentHash } from "../../src/store/planning-sync-state.js";

const MODEL_VERSION = "nomic-embed-text-v1.5";
const EMBED_MODEL = "text-embedding-nomic-embed-text-v1.5";

function card(id: string, content: string, kind: CardKind = "knowledge", frontmatter: Record<string, unknown> = {}): Card {
  return { id, kind, content, frontmatter };
}

/** Build a mock cardStore whose getCardsByKind returns the given cards per kind. */
function mockCardStore(byKind: Record<string, Card[]>): VectorBackfillCardStore {
  return {
    getCardsByKind: mock(async (kind: CardKind) => byKind[kind] ?? []),
  };
}

/** Build a mock vectorStore: getStoredHashes returns a copy of `hashes`;
 *  upsertVectors records every entry pushed. */
function mockVectorStore(hashes: Map<string, string>): {
  store: VectorBackfillVectorStore;
  upserts: VectorUpsertEntry[];
} {
  const upserts: VectorUpsertEntry[] = [];
  return {
    store: {
      getStoredHashes: mock(async () => new Map(hashes)),
      upsertVectors: mock(async (entries: VectorUpsertEntry[]) => {
        upserts.push(...entries);
      }),
    },
    upserts,
  };
}

/** Build a fake embedder that records every batch of texts + returns a
 *  deterministic vector per text. Call-count is read via `texts.length` (an
 *  array reference survives destructuring; a primitive `number` field would
 *  snapshot 0). */
function fakeEmbedder(): { embedder: Embedder; texts: string[][] } {
  const texts: string[][] = [];
  let n = 0;
  const embedder = mock(async (batch: string[], _model: string) => {
    n += 1;
    texts.push(batch);
    return batch.map((_, i) => [n, i, 0]);
  }) as unknown as Embedder;
  return { embedder, texts };
}

/** A throwing embedder (for the error-isolation case). */
function throwingEmbedder(): Embedder {
  return mock(async () => {
    throw new Error("LM Studio down");
  }) as unknown as Embedder;
}

/** setTimeoutFn that runs the callback on the microtask queue (so awaiting
 *  state.promise drives the deferred task to completion). */
function microtaskSetTimeout(): (cb: () => void, _ms: number) => number {
  return (cb) => {
    queueMicrotask(cb);
    return 0;
  };
}

describe("scheduleVectorBackfill — delta-key (T3)", () => {
  it("does NOT re-embed unchanged cards; embeds changed + new cards exactly once", async () => {
    // card-a: unchanged (stored hash == current) → NOT embedded.
    // card-b: stored hash stale → embedded once.
    // card-c: absent from stored (new) → embedded once.
    const a = card("a", "alpha content");
    const b = card("b", "beta content");
    const c = card("c", "gamma content");
    const cardStore = mockCardStore({ knowledge: [a, b, c] });

    const stored = new Map<string, string>([
      ["a", planningContentHash(a)], // unchanged
      ["b", "stale-hash-not-current"], // stale
      // "c" absent → new
    ]);
    const { store, upserts } = mockVectorStore(stored);
    const { embedder, texts } = fakeEmbedder();

    const state = createVectorBackfillState();
    const scheduled = scheduleVectorBackfill(cardStore, store, embedder, ["knowledge"], MODEL_VERSION, EMBED_MODEL, {
      state,
      setTimeoutFn: microtaskSetTimeout(),
    });

    expect(scheduled).toBe(true);
    await state.promise;

    // Embedder called exactly once (one batch of the 2 stale/new cards).
    expect(texts.length).toBe(1);
    // The batch contained ONLY card-b + card-c texts (NOT card-a).
    const embeddedTexts = texts.flat();
    expect(embeddedTexts).toContain("beta content");
    expect(embeddedTexts).toContain("gamma content");
    expect(embeddedTexts).not.toContain("alpha content");
    // Upsert received exactly the 2 delta cards, each tagged with modelVersion +
    // its CURRENT contentHash (the delta-key written back so the next run skips).
    expect(upserts).toHaveLength(2);
    const upsertedIds = new Set(upserts.map((e) => e.mdId));
    expect(upsertedIds).toEqual(new Set(["b", "c"]));
    for (const e of upserts) {
      expect(e.modelVersion).toBe(MODEL_VERSION);
      const src = e.mdId === "b" ? b : c;
      expect(e.contentHash).toBe(planningContentHash(src));
      expect(Array.isArray(e.vec)).toBe(true);
    }
    // State cleared after the run.
    expect(state.inProgress).toBe(false);
    expect(state.promise).toBeNull();
  });

  it("skips all embed work when every card is current (delta empty)", async () => {
    const a = card("a", "alpha");
    const b = card("b", "beta");
    const cardStore = mockCardStore({ knowledge: [a, b] });
    const stored = new Map<string, string>([
      ["a", planningContentHash(a)],
      ["b", planningContentHash(b)],
    ]);
    const { store, upserts } = mockVectorStore(stored);
    const { embedder, texts } = fakeEmbedder();

    const state = createVectorBackfillState();
    scheduleVectorBackfill(cardStore, store, embedder, ["knowledge"], MODEL_VERSION, EMBED_MODEL, {
      state,
      setTimeoutFn: microtaskSetTimeout(),
    });
    await state.promise;

    expect(texts.length).toBe(0); // no embed work
    expect(upserts).toHaveLength(0);
  });

  it("chunks stale cards into EMBED_BATCH-sized embed + upsert calls", async () => {
    const n = VECTOR_BACKFILL_EMBED_BATCH + 8; // 40 → 2 batches (32 + 8)
    const cards: Card[] = Array.from({ length: n }, (_, i) => card(`c${i}`, `body ${i}`));
    const cardStore = mockCardStore({ knowledge: cards });
    const { store, upserts } = mockVectorStore(new Map()); // all new → all delta
    const { embedder, texts } = fakeEmbedder();

    const state = createVectorBackfillState();
    scheduleVectorBackfill(cardStore, store, embedder, ["knowledge"], MODEL_VERSION, EMBED_MODEL, {
      state,
      setTimeoutFn: microtaskSetTimeout(),
    });
    await state.promise;

    expect(texts.length).toBe(2); // ceil(40/32) = 2 embed calls
    expect(texts[0]).toHaveLength(VECTOR_BACKFILL_EMBED_BATCH); // 32
    expect(texts[1]).toHaveLength(8);
    expect(upserts).toHaveLength(n); // every card upserted exactly once
    const ids = new Set(upserts.map((e) => e.mdId));
    expect(ids.size).toBe(n);
  });

  it("enumerates across multiple kinds", async () => {
    const k = card("k1", "knowledge body", "knowledge");
    const m = card("m1", "memory body", "memory");
    const cardStore = mockCardStore({ knowledge: [k], memory: [m] });
    const { store, upserts } = mockVectorStore(new Map());
    const { embedder } = fakeEmbedder();

    const state = createVectorBackfillState();
    scheduleVectorBackfill(cardStore, store, embedder, ["knowledge", "memory"], MODEL_VERSION, EMBED_MODEL, {
      state,
      setTimeoutFn: microtaskSetTimeout(),
    });
    await state.promise;

    const byId = new Map(upserts.map((e) => [e.mdId, e.kind] as const));
    expect(byId.get("k1")).toBe("knowledge");
    expect(byId.get("m1")).toBe("memory");
  });

  it("treats a different modelVersion as fully cold (re-embeds everything)", async () => {
    // card-a was stored under modelVersion "old"; querying "new" → absent → delta.
    const a = card("a", "alpha");
    const cardStore = mockCardStore({ knowledge: [a] });
    // stored map for "new" modelVersion is empty (the backfill queries the mv it
    // was given, so the empty map simulates "no rows for this lineage tag").
    const { store, upserts } = mockVectorStore(new Map());
    const { embedder, texts } = fakeEmbedder();

    const state = createVectorBackfillState();
    scheduleVectorBackfill(cardStore, store, embedder, ["knowledge"], "new-lineage-v2", EMBED_MODEL, {
      state,
      setTimeoutFn: microtaskSetTimeout(),
    });
    await state.promise;

    expect(texts.length).toBe(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.modelVersion).toBe("new-lineage-v2");
  });
});

describe("scheduleVectorBackfill — coalesce + isolation", () => {
  it("coalesces two concurrent schedules: second returns false, only one task runs", async () => {
    const a = card("a", "alpha");
    const cardStore = mockCardStore({ knowledge: [a] });
    const { store, upserts } = mockVectorStore(new Map());
    const { embedder, texts } = fakeEmbedder();

    const state = createVectorBackfillState();
    const first = scheduleVectorBackfill(cardStore, store, embedder, ["knowledge"], MODEL_VERSION, EMBED_MODEL, {
      state,
      setTimeoutFn: microtaskSetTimeout(),
    });
    const second = scheduleVectorBackfill(cardStore, store, embedder, ["knowledge"], MODEL_VERSION, EMBED_MODEL, {
      state,
      setTimeoutFn: microtaskSetTimeout(),
    });

    expect(first).toBe(true);
    expect(second).toBe(false); // inProgress guard
    await state.promise;

    expect(texts.length).toBe(1); // only the first task embedded
    expect(upserts).toHaveLength(1);
  });

  it("swallows an embedder throw: inProgress cleared, promise resolves, notify warns", async () => {
    const a = card("a", "alpha");
    const cardStore = mockCardStore({ knowledge: [a] });
    const { store, upserts } = mockVectorStore(new Map());
    const notifications: { message: string; level: string }[] = [];

    const state = createVectorBackfillState();
    scheduleVectorBackfill(cardStore, store, throwingEmbedder(), ["knowledge"], MODEL_VERSION, EMBED_MODEL, {
      state,
      setTimeoutFn: microtaskSetTimeout(),
      notify: (message, level) => notifications.push({ message, level }),
    });

    // Must NOT reject — the throw is error-isolated inside the deferred task.
    await state.promise;

    expect(state.inProgress).toBe(false);
    expect(state.promise).toBeNull();
    expect(upserts).toHaveLength(0);
    const warn = notifications.find((n) => /Vector backfill failed/.test(n.message));
    expect(warn).toBeDefined();
    expect(warn!.level).toBe("warning");
  });

  it("swallows an upsert throw the same way", async () => {
    const a = card("a", "alpha");
    const cardStore = mockCardStore({ knowledge: [a] });
    const throwingStore: VectorBackfillVectorStore = {
      getStoredHashes: mock(async () => new Map()),
      upsertVectors: mock(async () => {
        throw new Error("SurrealDB down");
      }),
    };
    const { embedder } = fakeEmbedder();
    const notifications: { message: string; level: string }[] = [];

    const state = createVectorBackfillState();
    scheduleVectorBackfill(cardStore, throwingStore, embedder, ["knowledge"], MODEL_VERSION, EMBED_MODEL, {
      state,
      setTimeoutFn: microtaskSetTimeout(),
      notify: (message, level) => notifications.push({ message, level }),
    });
    await state.promise;

    expect(state.inProgress).toBe(false);
    expect(notifications[0]!.level).toBe("warning");
    expect(notifications[0]!.message).toMatch(/SurrealDB down/);
  });

  it("is a no-op when the card store has no cards of the given kinds", async () => {
    const cardStore = mockCardStore({ knowledge: [] });
    const { store, upserts } = mockVectorStore(new Map());
    const { embedder, texts } = fakeEmbedder();

    const state = createVectorBackfillState();
    scheduleVectorBackfill(cardStore, store, embedder, ["knowledge"], MODEL_VERSION, EMBED_MODEL, {
      state,
      setTimeoutFn: microtaskSetTimeout(),
    });
    await state.promise;

    expect(texts.length).toBe(0);
    expect(upserts).toHaveLength(0);
  });
});

describe("waitForVectorBackfill — shutdown drain", () => {
  it("resolves true when no backfill is running", async () => {
    const state = createVectorBackfillState();
    const ok = await waitForVectorBackfill(50, state);
    expect(ok).toBe(true);
  });

  it("resolves true when an in-progress backfill completes before the timeout", async () => {
    let resolveTask!: () => void;
    const state: VectorBackfillState = {
      inProgress: true,
      promise: new Promise<void>((resolve) => {
        resolveTask = resolve;
      }),
    };
    setTimeout(resolveTask, 5);
    const ok = await waitForVectorBackfill(200, state);
    expect(ok).toBe(true);
  });

  it("resolves false when the in-progress backfill exceeds the timeout", async () => {
    const state: VectorBackfillState = {
      inProgress: true,
      promise: new Promise<void>(() => {
        /* never resolves */
      }),
    };
    const ok = await waitForVectorBackfill(5, state);
    expect(ok).toBe(false);
  });
});
