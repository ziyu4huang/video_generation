import { describe, expect, it } from "bun:test";
import { DEFAULT_EXTRACT, type ExtractStrategy, parseExtractStrategy } from "../src/vlm/extract-strategy.ts";

describe("parseExtractStrategy", () => {
  it("defaults to vlm", () => {
    expect(parseExtractStrategy(undefined)).toBe("vlm");
    expect(DEFAULT_EXTRACT).toBe("vlm");
  });
  it("accepts the three valid values", () => {
    expect(parseExtractStrategy("vlm")).toBe("vlm");
    expect(parseExtractStrategy("text")).toBe("text");
    expect(parseExtractStrategy("hybrid")).toBe("hybrid");
  });
  it("rejects invalid values", () => {
    expect(() => parseExtractStrategy("ocr")).toThrow(/Invalid extract/);
    expect(() => parseExtractStrategy("")).toThrow(/Invalid extract/);
  });
});
