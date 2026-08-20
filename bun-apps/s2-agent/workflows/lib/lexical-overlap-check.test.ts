/**
 * Unit tests for the lexical-overlap-check gate.
 *
 * The gate prevents the retrieval-quality loop from being rigged: a generated
 * "adversarial" query that shares a title/tag token with a card lets lexical
 * search win by cheating. These tests prove the pure tokenization + overlap
 * logic is correct for both Latin and CJK (zh-TW cross-lingual) text.
 */
import { describe, expect, test } from "bun:test";
import {
  extractLatinTokens,
  extractCjkBigrams,
  extractCardTerms,
  extractQueryTokens,
  findLexicalOverlap,
  checkQueriesForOverlap,
  parseNoteMetadata,
} from "./lexical-overlap-check.mjs";

describe("extractLatinTokens", () => {
  test("splits on non-word chars, lowercases, keeps ≥3-char tokens", () => {
    expect(extractLatinTokens("Flux2 Region-Attention Binding")).toEqual(
      ["flux2", "region", "attention", "binding"],
    );
  });

  test("filters stopwords and short tokens", () => {
    const tokens = extractLatinTokens("the GPU is a key thing to fix");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("is");
    expect(tokens).not.toContain("fix"); // stopword
    expect(tokens).not.toContain("a"); // <3 chars
    expect(tokens).toContain("gpu");
    expect(tokens).toContain("key");
  });

  test("empty/null input returns []", () => {
    expect(extractLatinTokens("")).toEqual([]);
    expect(extractLatinTokens(null)).toEqual([]);
  });
});

describe("extractCjkBigrams", () => {
  test("extracts 2-char CJK sliding window", () => {
    // 3 CJK chars → 2 bigrams
    const bigrams = extractCjkBigrams("記憶體");
    expect(bigrams).toContain("記憶");
    expect(bigrams).toContain("憶體");
    expect(bigrams).toHaveLength(2);
  });

  test("returns [] for pure-Latin text", () => {
    expect(extractCjkBigrams("memory leak")).toEqual([]);
  });

  test("strips non-CJK chars before windowing", () => {
    // 模型-注意 → bigrams of 模型注意 (Latin/dash stripped)
    const bigrams = extractCjkBigrams("模型-注意");
    expect(bigrams).toContain("模型");
    expect(bigrams).toContain("型注");
    expect(bigrams).toContain("注意");
  });
});

describe("extractCardTerms", () => {
  test("combines title + tags, Latin + CJK", () => {
    const terms = extractCardTerms("Flux2 記憶體", ["lora", "gpu-explode"]);
    expect(terms.has("flux2")).toBe(true);
    expect(terms.has("記憶")).toBe(true); // CJK bigram from title
    expect(terms.has("lora")).toBe(true);
    expect(terms.has("gpu")).toBe(true); // "gpu-explode" → gpu, explode
  });
});

describe("findLexicalOverlap", () => {
  const cardTerms = extractCardTerms("Flux2 Region Attention", ["binding", "記憶體"]);

  test("detects shared Latin token", () => {
    // "flux2" appears in card title → overlap
    const r = findLexicalOverlap("why does flux2 crash on big images", cardTerms);
    expect(r.overlap).toBe(true);
    expect(r.matchedTerms).toContain("flux2");
  });

  test("detects shared CJK bigram", () => {
    // "記憶" is a bigram from the 記憶體 tag
    const r = findLexicalOverlap("為什麼顯示卡記憶不夠", cardTerms);
    expect(r.overlap).toBe(true);
    expect(r.matchedTerms).toContain("記憶");
  });

  test("no overlap for a clean adversarial query", () => {
    // Paraphrased concept with zero vocabulary overlap
    const r = findLexicalOverlap("the neural net ran out of VRAM during inference", cardTerms);
    expect(r.overlap).toBe(false);
    expect(r.matchedTerms).toEqual([]);
  });

  test("region/attention from card title are caught", () => {
    const r = findLexicalOverlap("how does region binding work", cardTerms);
    expect(r.overlap).toBe(true);
    expect(r.matchedTerms).toContain("region");
    expect(r.matchedTerms).toContain("binding");
  });
});

describe("checkQueriesForOverlap", () => {
  const cardTerms = extractCardTerms("LoRA Fusion", ["quantization"]);

  test("clean batch (all adversarial)", () => {
    const queries = [
      { id: 1, text: "why does the adapter merge blow up weights" },
      { id: 2, text: "how to shrink a model without losing precision" },
    ];
    const r = checkQueriesForOverlap(queries, cardTerms);
    expect(r.clean).toBe(true);
    expect(r.overlaps).toEqual([]);
  });

  test("flags overlapping queries with matchedTerms", () => {
    const queries = [
      { id: 1, text: "why does the adapter merge blow up weights" }, // clean
      { id: 2, text: "how does LoRA fusion work" }, // "lora" + "fusion" overlap
      { id: 3, text: "best quantization settings" }, // "quantization" overlap
    ];
    const r = checkQueriesForOverlap(queries, cardTerms);
    expect(r.clean).toBe(false);
    expect(r.overlaps).toHaveLength(2);
    expect(r.overlaps[0]!.queryId).toBe(2);
    expect(r.overlaps[0]!.matchedTerms).toContain("lora");
    expect(r.overlaps[1]!.queryId).toBe(3);
  });
});

describe("parseNoteMetadata", () => {
  test("extracts frontmatter title + tags", () => {
    const md = `---
title: "Flux2 Region Attention"
tags: [binding, distilled-klein, 記憶體]
---
# Body`;
    const { title, tags } = parseNoteMetadata(md);
    expect(title).toBe("Flux2 Region Attention");
    expect(tags).toContain("binding");
    expect(tags).toContain("記憶體");
  });

  test("falls back to H1 when no frontmatter title", () => {
    const md = `# My Card Title\n\nbody`;
    const { title } = parseNoteMetadata(md);
    expect(title).toBe("My Card Title");
  });

  test("handles missing frontmatter gracefully", () => {
    const { title, tags } = parseNoteMetadata("just body text");
    expect(title).toBe("");
    expect(tags).toEqual([]);
  });
});

describe("extractQueryTokens (parity with extractCardTerms)", () => {
  test("uses the same tokenization so overlap is symmetric", () => {
    const text = "flux2 記憶體 leak";
    const queryTokens = extractQueryTokens(text);
    const cardTerms = extractCardTerms(text);
    // Same tokens extracted from the same text via both paths
    for (const t of cardTerms) expect(queryTokens.has(t)).toBe(true);
  });
});
