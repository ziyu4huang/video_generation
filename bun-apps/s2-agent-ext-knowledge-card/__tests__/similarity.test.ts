/**
 * Unit tests for the shared token-set similarity primitives.
 *
 * These underpin BOTH the wiki-aware ingest matcher (ingest.ts, threshold 0.85)
 * AND the duplicate scanner (merge.ts, threshold 0.9). They must agree on what
 * counts as "the same concept" — this test guards that contract.
 */
import { test, expect, describe } from "bun:test";
import { tokeniseText, jaccard, bestMatch } from "../src/similarity.ts";

describe("tokeniseText", () => {
  test("lowercases + splits on non-alphanumeric", () => {
    const t = tokeniseText("Bun Uses Isolated Linker!");
    expect(t.has("isolated")).toBe(true);
    expect(t.has("linker")).toBe(true);
    expect(t.has("bun")).toBe(true);
    expect(t.has("the")).toBe(false); // not present
  });

  test("drops short ASCII tokens (<3 chars) + stopwords", () => {
    const t = tokeniseText("the a an to use via is");
    expect(t.size).toBe(0);
  });

  test("keeps CJK tokens (no stopword filtering)", () => {
    const t = tokeniseText("核心想法是 atomic write");
    // CJK chars don't split on word boundaries → "核心想法是" is one token.
    expect(t.has("核心想法是")).toBe(true);
    expect(t.has("atomic")).toBe(true);
    expect(t.has("write")).toBe(true);
  });

  test("empty / whitespace input → empty set", () => {
    expect(tokeniseText("").size).toBe(0);
    expect(tokeniseText("   ").size).toBe(0);
  });
});

describe("jaccard", () => {
  test("identical sets → 1.0", () => {
    const a = tokeniseText("bun workspace isolated linker");
    const b = tokeniseText("bun workspace isolated linker");
    expect(jaccard(a, b)).toBe(1);
  });

  test("disjoint sets → 0", () => {
    const a = tokeniseText("apple banana");
    const b = tokeniseText("cherry durian");
    expect(jaccard(a, b)).toBe(0);
  });

  test("two empty sets → 0", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  test("partial overlap → 0 < sim < 1", () => {
    const a = tokeniseText("bun workspace isolated linker globalstore");
    const b = tokeniseText("bun workspace isolated linker lockfile");
    const sim = jaccard(a, b);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });
});

describe("bestMatch", () => {
  test("finds the best candidate at or above threshold", () => {
    const query = tokeniseText("bun workspace isolated linker globalstore");
    const candidates = [
      tokeniseText("cherry durian"), // no overlap
      tokeniseText("bun workspace isolated linker lockfile"), // partial
      tokeniseText("bun workspace isolated linker globalstore canonical"), // near-identical
    ];
    const m = bestMatch(query, candidates, 0.5);
    expect(m.index).toBe(2);
    expect(m.similarity).toBeGreaterThan(0.5);
  });

  test("returns -1 when no candidate meets threshold", () => {
    const query = tokeniseText("apple banana");
    const candidates = [
      tokeniseText("cherry durian"),
      tokeniseText("bun workspace"),
    ];
    const m = bestMatch(query, candidates, 0.85);
    expect(m.index).toBe(-1);
  });

  test("empty query → no match", () => {
    const m = bestMatch(new Set(), [tokeniseText("something")], 0.1);
    expect(m.index).toBe(-1);
  });
});
