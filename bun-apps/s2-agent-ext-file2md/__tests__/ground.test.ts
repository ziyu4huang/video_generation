/**
 * ground.test.ts — the deterministic vision-grounding pre-check (ticket 03).
 *
 * The verified fixture from the 2026-09-09 review: the "相似度 92%" bullet in
 * fig-2609.09156.md IS grounded (page-001 text layer line 89 carries
 * `Similarity Score: 92% (High Overlap)`), and a hallucinated number variant
 * MUST flag. Plus boundary cases: CJK labels, multi-word named runs,
 * stop-tokens never checked, prose-page false-positive resistance.
 */
import { describe, expect, test } from "bun:test";
import { extractCheckableTokens, groundClaim, groundClaims } from "../src/vlm/ground.ts";

const RECITE_PAGE = `
Similarity Score: 92% (High Overlap)
Figure 1: Comparison of citation paradigms: Traditional RAG vs ReCite.
Proximal Policy Optimization Algorithms
DeepSeekMath: Pushing the Limits
`;

describe("groundClaim", () => {
  test("VERIFIED fixture: the 92% similarity bullet grounds against page-001", () => {
    const claim = "- 相似度檢索 RAG 流程：相似度分數 92%（高重疊）即直接引用。";
    const r = groundClaim(claim, RECITE_PAGE);
    expect(r.grounded).toBe(true);
    expect(r.missing).toEqual([]);
  });

  test("hallucinated number variant MUST flag (the class finding 4 guards)", () => {
    const claim = "- 相似度分數 87%（高重疊）即直接引用。";
    const r = groundClaim(claim, RECITE_PAGE);
    expect(r.grounded).toBe(false);
    expect(r.missing).toContain("87%");
  });

  test("digit-subsumption: bare 234 does NOT ground via 1,234 (full-review finding 1)", () => {
    const r = groundClaim("- claim: 234 samples evaluated.", "we evaluated 1,234 samples in total.");
    expect(r.grounded).toBe(false);
    expect(r.missing).toContain("234");
  });

  test("digit-subsumption: 7B does NOT ground via 17B", () => {
    const r = groundClaim("- a 7B model was used.", "the 17B baseline was compared.");
    expect(r.grounded).toBe(false);
    expect(r.missing).toContain("7B");
  });

  test("boundary-aware match still grounds exact numbers glued to units", () => {
    const r = groundClaim("- 7B model, 92% accuracy.", "the 7B model reached 92% accuracy.");
    expect(r.grounded).toBe(true);
  });

  test("grounded named entity: multi-word capitalized run found verbatim", () => {
    const r = groundClaim("- 檢索候選為 Proximal Policy Optimization Algorithms。", RECITE_PAGE);
    expect(r.grounded).toBe(true);
  });

  test("ungrounded named entity flags with the missing run", () => {
    const r = groundClaim("- 檢索候選為 Group Relative Policy Optimization。", RECITE_PAGE);
    expect(r.grounded).toBe(false);
    expect(r.missing.some((m) => m.includes("Group Relative"))).toBe(true);
  });

  test("CJK labels ground against CJK-bearing page text", () => {
    const r = groundClaim("- 「壞散文」→「原子 Item」。", "01 / 壞散文 02 / Itemize 原子 Item ×4");
    expect(r.grounded).toBe(true);
  });

  test("CJK tokens skip against a Latin-only page (cross-language paraphrase is by design)", () => {
    const r = groundClaim("- 相似度檢索 RAG 流程：相似度分數 92%。", RECITE_PAGE);
    expect(r.grounded).toBe(true); // the number grounds; CJK cannot be required
  });

  test("case-insensitive Latin match", () => {
    const r = groundClaim("- The GMSBench suite.", "evaluated via gmsbench across settings.");
    expect(r.grounded).toBe(true);
  });
});

describe("extractCheckableTokens", () => {
  test("numbers extracted verbatim (percent, decimal, thousands)", () => {
    expect(extractCheckableTokens("accuracy 92.5% with 1,234 samples and 3.8x speedup")).toContain("92.5%");
    expect(extractCheckableTokens("accuracy 92.5% with 1,234 samples and 3.8x speedup")).toContain("1,234");
    expect(extractCheckableTokens("accuracy 92.5% with 1,234 samples and 3.8x speedup")).toContain("3.8x");
  });

  test("stop-tokens and sentence-initial singles are not checkable", () => {
    const toks = extractCheckableTokens("The method shows results on the left panel of the figure.");
    expect(toks).toEqual([]);
  });
});

describe("groundClaims", () => {
  test("splits a description into per-line results; headers skipped", () => {
    const desc = "**架構描述**\n- 相似度分數 92%。\n- 模型规模 7B 参数。";
    const rs = groundClaims(desc, RECITE_PAGE);
    expect(rs).toHaveLength(2);
    expect(rs[0]!.grounded).toBe(true);
    expect(rs[1]!.grounded).toBe(false); // 7B is not on the page
    expect(rs[1]!.missing).toContain("7B");
  });
});
