import { describe, expect, it } from "bun:test";
import { detectFigurePages } from "../src/vlm/figure-detect.ts";

const page = (n: number, text: string) => ({ pageNo: n, text });

describe("detectFigurePages", () => {
  it("flags low-text-density pages relative to the median", () => {
    const pages = [page(1, "x".repeat(2000)), page(2, "y".repeat(200)), page(3, "z".repeat(1900))];
    const fig = detectFigurePages(pages); // median ~1900; p2 (200) < 0.5*1900=950 → flagged
    expect(fig.has(2)).toBe(true);
    expect(fig.has(1)).toBe(false);
    expect(fig.has(3)).toBe(false);
  });
  it("flags pages with a Figure caption token regardless of density", () => {
    const pages = [page(1, "x".repeat(2000)), page(2, "Figure 3: the thing. " + "q".repeat(2000))];
    const fig = detectFigurePages(pages);
    expect(fig.has(2)).toBe(true);
  });
  it("returns empty for uniform text pages", () => {
    const pages = [page(1, "a".repeat(2000)), page(2, "b".repeat(2000))];
    expect(detectFigurePages(pages).size).toBe(0);
  });
});
