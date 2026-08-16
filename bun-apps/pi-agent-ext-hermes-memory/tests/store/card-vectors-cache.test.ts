import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cosineSimilarity,
  loadCardVectorsCache,
  removeCachedCardVectors,
  upsertCachedCardVectors,
  type CachedCardVector,
} from "../../src/store/card-vectors-cache.ts";

function entry(mdId: string, vec: number[]): CachedCardVector {
  return { mdId, kind: "memory", embedModel: "m-test", contentHash: `hash-${mdId}`, vec };
}

describe("card-vectors-cache", () => {
  it("round-trips upserts and overwrites by mdId", () => {
    const dir = mkdtempSync(join(tmpdir(), "cvc-"));
    try {
      upsertCachedCardVectors(dir, [entry("a.md", [1, 0]), entry("b.md", [0, 1])]);
      let cache = loadCardVectorsCache(dir);
      assert.equal(cache.size, 2);
      assert.deepEqual(cache.get("a.md")?.vec, [1, 0]);
      assert.deepEqual(cache.get("b.md")?.vec, [0, 1]);

      upsertCachedCardVectors(dir, [entry("a.md", [0.5, 0.5])]);
      cache = loadCardVectorsCache(dir);
      assert.equal(cache.size, 2);
      assert.deepEqual(cache.get("a.md")?.vec, [0.5, 0.5]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty map for a corrupt cache file without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cvc-"));
    try {
      writeFileSync(join(dir, "card-vectors-cache.json"), "not json {", "utf8");
      const cache = loadCardVectorsCache(dir);
      assert.equal(cache.size, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes only the listed mdIds", () => {
    const dir = mkdtempSync(join(tmpdir(), "cvc-"));
    try {
      upsertCachedCardVectors(dir, [entry("a.md", [1, 0]), entry("b.md", [0, 1]), entry("c.md", [1, 1])]);
      removeCachedCardVectors(dir, ["a.md", "missing.md"]);
      const cache = loadCardVectorsCache(dir);
      assert.equal(cache.size, 2);
      assert.ok(!cache.has("a.md"));
      assert.ok(cache.has("b.md"));
      assert.ok(cache.has("c.md"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cosineSimilarity: identical ≈1, orthogonal ≈0, mismatched lengths clamp", () => {
    assert.ok(cosineSimilarity([1, 2, 3], [1, 2, 3]) > 0.999);
    assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 0.001);
    // mismatched lengths: must not throw; clamped to shared prefix
    const score = cosineSimilarity([1, 0, 0, 0], [1, 0]);
    assert.ok(score > 0.999);
    assert.equal(cosineSimilarity([0, 0], [0, 0]), 0);
  });
});
