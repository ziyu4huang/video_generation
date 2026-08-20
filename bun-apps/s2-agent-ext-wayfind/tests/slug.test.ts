import { describe, expect, it } from "bun:test";
import { slugify } from "../src/wayfinder.js";

// Failure memory #444 — slugify truncation regression suite.
//
// The fix (5f78023b) changed the truncation rule but had NO tests locking the
// behaviour, so a naive `.slice(0, 48)` (no word-boundary cut, no re-trim)
// could silently regress to either a mid-word cut or a dangling trailing `-`.
// These tests structurally pin both: a long name is cut at the last `-` at or
// before index 48 (a word boundary, never mid-word), and the result never ends
// in a dangling `-` even when the 48-char slice lands exactly on a dash.
// Short names pass through unchanged.

describe("slugify truncation (failure memory #444)", () => {
  it("cuts a long name at the last word boundary at or before index 48 (not mid-word)", () => {
    // normalized: alpha-beta-gamma-delta-epsilon-zeta-eta-theta-iota-kappa (56 chars).
    // The 48-char slice lands mid-word inside "...theta-io" (a dangling "io" of iota).
    // The fix must back up to the last `-` (before "iota") → ends cleanly at "theta".
    const out = slugify("Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa");
    expect(out).toBe("alpha-beta-gamma-delta-epsilon-zeta-eta-theta");
    // the naive slice would have produced "...theta-io" — assert we never ship a
    // mid-word fragment (no partial "io" tail, no "-i" word boundary remnant).
    expect(out).not.toMatch(/-io$/);
    expect(out).not.toMatch(/-i$/);
  });

  it("re-trims a trailing dash left by the slice (no dangling `-`)", () => {
    // normalized: alpha-beta-gamma-delta-epsilon-zeta-eta-foxtrot-golf (52 chars).
    // The 48-char slice lands exactly on the `-` before "golf" → "...foxtrot-".
    // That trailing dash MUST be re-trimmed, not shipped as a dangling slug tail
    // (the "...-prevous-wayfind-" regression class).
    const out = slugify("Alpha Beta Gamma Delta Epsilon Zeta Eta Foxtrot Golf");
    expect(out).toBe("alpha-beta-gamma-delta-epsilon-zeta-eta-foxtrot");
    expect(out).not.toMatch(/-$/); // never a dangling trailing dash
  });

  it("never exceeds 48 chars, even for a single very long word (hard cut)", () => {
    // No `-` in the first 48 chars → nothing to back up to → hard cut at 48 is the
    // only option, but still no trailing dash (the word has none).
    const out = slugify("x".repeat(80));
    expect(out.length).toBeLessThanOrEqual(48);
    expect(out).not.toMatch(/-$/);
  });

  it("passes short names through unchanged", () => {
    expect(slugify("Storage Layer")).toBe("storage-layer");
    expect(slugify("a")).toBe("a");
    expect(slugify("Orders Service v2!")).toBe("orders-service-v2");
  });
});
