import { describe, it, expect } from "bun:test";
import { rankMemoryEntries } from "../../src/store/graph-ranker.js";
import type { MemoryEntry } from "../../src/store/repository.js";

/** Minimal MemoryEntry builder for ranker tests — only fields the ranker reads. */
function mk(partial: Partial<MemoryEntry> & Pick<MemoryEntry, "id">): MemoryEntry {
  return {
    id: partial.id,
    project: partial.project ?? null,
    target: partial.target ?? "memory",
    category: partial.category ?? null,
    content: partial.content ?? "x",
    failureReason: null,
    toolState: null,
    correctedTo: null,
    created: partial.created ?? "2026-01-01T00:00:00.000Z",
    lastReferenced: partial.lastReferenced ?? "2026-01-01T00:00:00.000Z",
    mwSuccess: partial.mwSuccess,
    mwFail: partial.mwFail,
  };
}

const NOW = new Date("2026-07-28T00:00:00.000Z");
const daysAgo = (n: number): string =>
  new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("rankMemoryEntries", () => {
  it("ranks a lexical match above a graph neighbor even when the neighbor is more recent", () => {
    // A: lexical match, shares project P1, but stale (100 days ago).
    const a = mk({ id: 1, project: "P1", lastReferenced: daysAgo(100) });
    // B: graph neighbor (NOT lexical), shares project P1, fresh (now).
    const b = mk({ id: 2, project: "P1", lastReferenced: daysAgo(0) });

    const ranked = rankMemoryEntries({
      candidates: [b, a], // deliberately out of order
      lexicalMatchIds: new Set([1]),
      limit: 10,
      now: NOW,
    });

    expect(ranked.map((m) => m.id)).toEqual([1, 2]); // A (lexical) before B (neighbor)
  });

  it("ranks a neighbor sharing more implicit tags above one sharing fewer", () => {
    // Seed A is the sole lexical match; its tags seed the graph.
    const a = mk({ id: 1, project: "P1", category: "insight", target: "memory", lastReferenced: daysAgo(0) });
    // X shares all 3 implicit tags with the seed; Y shares only 1. Same recency.
    const x = mk({ id: 2, project: "P1", category: "insight", target: "memory", lastReferenced: daysAgo(0) });
    const y = mk({ id: 3, project: "P1", category: "convention", target: "failure", lastReferenced: daysAgo(0) });

    const ranked = rankMemoryEntries({
      candidates: [y, x, a],
      lexicalMatchIds: new Set([1]),
      limit: 10,
      now: NOW,
    });

    // a (lexical) first, then x (shares 3) before y (shares 1).
    expect(ranked.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it("among lexical matches with equal graphProximity, a more recent one outranks a staler one", () => {
    const recent = mk({ id: 1, project: "P1", lastReferenced: daysAgo(1) });
    const stale = mk({ id: 2, project: "P1", lastReferenced: daysAgo(100) });

    const ranked = rankMemoryEntries({
      candidates: [stale, recent],
      lexicalMatchIds: new Set([1, 2]),
      limit: 10,
      now: NOW,
    });

    expect(ranked.map((m) => m.id)).toEqual([1, 2]); // recent before stale
  });

  it("truncates to the limit, keeping the highest-scored entries", () => {
    const a = mk({ id: 1, project: "P1", lastReferenced: daysAgo(0) }); // lexical
    const b = mk({ id: 2, project: "P1", lastReferenced: daysAgo(0) }); // neighbor, shares 1
    const c = mk({ id: 3, project: "P2", lastReferenced: daysAgo(0) }); // neighbor, shares 0

    const ranked = rankMemoryEntries({
      candidates: [c, b, a],
      lexicalMatchIds: new Set([1]),
      limit: 2,
      now: NOW,
    });

    expect(ranked).toHaveLength(2);
    expect(ranked.map((m) => m.id)).toEqual([1, 2]); // a (lexical), b (shares 1); c dropped
  });

  it("worth multiplier ranks a high-success entry above a low-success one at equal lexical/graph/recency", () => {
    const low = mk({ id: 1, mwSuccess: 0, mwFail: 8 });   // p_success ≈ 0.1 → mult ≈ 0.2 (sinks)
    const high = mk({ id: 2, mwSuccess: 8, mwFail: 0 });  // p_success ≈ 0.9 → mult ≈ 1.8 (boosts)
    const out = rankMemoryEntries({ candidates: [low, high], lexicalMatchIds: new Set([1, 2]), limit: 2 });
    expect(out[0].id).toBe(2);  // high-worth first
    expect(out[1].id).toBe(1);
  });

  it("uninstrumented (0/0) entries get multiplier 1.0 — no ranking bias", () => {
    const a = mk({ id: 1 });  // mwSuccess/mwFail undefined → ?? 0 → mult 1.0
    const b = mk({ id: 2 });
    const out = rankMemoryEntries({ candidates: [a, b], lexicalMatchIds: new Set([1, 2]), limit: 2 });
    // tie → deterministic id-ascending tiebreak
    expect(out.map((e) => e.id)).toEqual([1, 2]);
  });
});
