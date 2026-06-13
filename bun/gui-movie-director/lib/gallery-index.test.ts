import { describe, it, expect, beforeEach } from "bun:test";
import { isIndexed, buildIndex, invalidateIndex, searchImages } from "./gallery-index";

const SAMPLE = [
  {
    name: "fluffy-cat.png",
    mediaType: "image",
    createdAt: new Date().toISOString(),
    run: { prompt: "a fluffy cat sitting on a mat, cinematic outdoor" },
    manifest: { command: "t2i", model: "flux2" },
  },
  {
    name: "golden-retriever.mp4",
    mediaType: "video",
    createdAt: new Date().toISOString(),
    run: { prompt: "golden retriever running outdoor, cinematic style" },
    manifest: { command: "video", model: "ltx" },
  },
];

beforeEach(() => {
  invalidateIndex();
});

describe("gallery-index: state management", () => {
  it("isIndexed() is false before any buildIndex call", () => {
    expect(isIndexed()).toBe(false);
  });

  it("buildIndex([]) sets indexed flag to true", () => {
    buildIndex([]);
    expect(isIndexed()).toBe(true);
  });

  it("invalidateIndex() resets indexed flag to false", () => {
    buildIndex([]);
    invalidateIndex();
    expect(isIndexed()).toBe(false);
  });
});

describe("gallery-index: searchImages", () => {
  it("matches by name field", () => {
    buildIndex(SAMPLE);
    const results = searchImages("fluffy-cat");
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("fluffy-cat.png");
  });

  it("matches by prompt content", () => {
    buildIndex(SAMPLE);
    const results = searchImages("golden");
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("golden-retriever.mp4");
  });

  it("returns empty array when query has no match", () => {
    buildIndex(SAMPLE);
    const results = searchImages("zzz-no-match-xyz");
    expect(results).toHaveLength(0);
  });

  it("filters by mediaType image", () => {
    buildIndex(SAMPLE);
    const results = searchImages("cat", "image");
    expect(results.every((r: any) => r.mediaType === "image")).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it("filters by mediaType video", () => {
    buildIndex(SAMPLE);
    const results = searchImages("retriever", "video");
    expect(results.every((r: any) => r.mediaType === "video")).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it("does not throw on special characters in query", () => {
    buildIndex(SAMPLE);
    expect(() => searchImages('cat (fluffy) "sitting"')).not.toThrow();
    expect(() => searchImages("cat^2 OR dog*")).not.toThrow();
  });

  it("returns all matching entries across both mediaTypes when no type filter", () => {
    buildIndex(SAMPLE);
    const results = searchImages("cinematic");
    expect(results.length).toBe(2);
  });
});
