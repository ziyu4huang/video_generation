import { describe, it, expect } from "bun:test";
import { getManifestSummary } from "./GalleryCard";

describe("getManifestSummary", () => {
  it("returns null for null input", () => {
    expect(getManifestSummary(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(getManifestSummary(undefined)).toBeNull();
  });

  it("formats command + pipeline + seed", () => {
    const result = getManifestSummary({ command: "t2i", pipeline: "flux", seed: 42 });
    expect(result).toBe("t2i · flux · seed:42");
  });

  it("omits missing fields", () => {
    const result = getManifestSummary({ command: "video generate", seed: 100 });
    expect(result).toBe("video generate · seed:100");
  });

  it("handles seed = 0 correctly", () => {
    const result = getManifestSummary({ command: "t2i", seed: 0 });
    expect(result).toContain("seed:0");
  });

  it("returns null when all fields are missing", () => {
    const result = getManifestSummary({});
    expect(result).toBeNull();
  });
});
