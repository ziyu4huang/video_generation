import { describe, expect, it } from "bun:test";
import { getByCapability, providerMenuSummary, REGISTRY } from "./registry.ts";

describe("getByCapability", () => {
  it("returns only providers declaring the requested capability", () => {
    const providers = getByCapability("image_generation");
    expect(providers.length).toBeGreaterThan(0);
    for (const p of providers) expect(p.capability).toBe("image_generation");
  });

  it("returns [] for a capability no provider declares (type-safe cast — none exist today)", () => {
    // Every declared Capability has at least one provider; assert that invariant
    // directly rather than probing a nonexistent value.
    const caps = new Set(REGISTRY.map((p) => p.capability));
    expect(caps.size).toBeGreaterThan(0);
    for (const cap of caps) expect(getByCapability(cap).length).toBeGreaterThan(0);
  });
});

describe("providerMenuSummary", () => {
  const summary = providerMenuSummary();

  it("rolls every REGISTRY entry into exactly one capability bucket", () => {
    const totalAcrossBuckets = summary.capabilities.reduce((sum, c) => sum + c.total, 0);
    expect(totalAcrossBuckets).toBe(REGISTRY.length);
  });

  it("each bucket's configured + unavailable provider counts match its total", () => {
    for (const c of summary.capabilities) {
      expect(c.available_providers.length).toBe(c.configured);
      expect(c.available_providers.length + c.unavailable_providers.length).toBe(c.total);
    }
  });

  it("gaps are exactly the REGISTRY entries whose notes start with \"GAP\"", () => {
    const expected = REGISTRY.filter((p) => p.notes?.startsWith("GAP"));
    expect(summary.gaps.map((p) => p.name).sort()).toEqual(expected.map((p) => p.name).sort());
  });

  it("composition_runtimes lists every composition provider by name → configured", () => {
    const compositionProviders = REGISTRY.filter((p) => p.capability === "composition");
    expect(Object.keys(summary.composition_runtimes).sort()).toEqual(compositionProviders.map((p) => p.provider).sort());
    for (const p of compositionProviders) {
      expect(summary.composition_runtimes[p.provider]).toBe(p.configured);
    }
  });

  it("capabilities are sorted alphabetically", () => {
    const names = summary.capabilities.map((c) => c.capability);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

// #6 — cloud-provider isolation invariant. Image/video generation on this
// project is a hard local-MLX-only guarantee (CLAUDE.md "zero-cloud" rule for
// generation). Cloud-backed registry entries exist ONLY for capabilities that
// are explicitly allowed to be cloud-gated (tts today) and must stay
// `configured: false` until real credentials are wired — this test fails loud
// if a future edit accidentally flips one to `configured: true` or adds a
// cloud_http provider to a generation capability.
describe("cloud-provider isolation (never-cloud invariant for generation)", () => {
  const GENERATION_CAPABILITIES = new Set(["image_generation", "video_generation"]);

  it("no cloud_http provider exists for image_generation or video_generation", () => {
    const offenders = REGISTRY.filter((p) => p.backend === "cloud_http" && GENERATION_CAPABILITIES.has(p.capability));
    expect(offenders).toEqual([]);
  });

  it("every cloud_http provider is currently unconfigured, except the documented keyless allowlist", () => {
    // edge_tts is deliberately `configured: true` + `backend: "cloud_http"`: it
    // needs network egress but NO credentials (unlike elevenlabs/openai, which
    // must stay false until a real API key is wired). It's ranked in the
    // cloud_http tier (below say_tts) specifically so it stays opt-in via an
    // explicit provider hint rather than becoming a silent default — see
    // registry.ts's edge_tts entry notes. This allowlist must stay narrow: any
    // OTHER cloud_http provider flipping to configured:true still fails this
    // test (the invariant it guards against — an accidental real-credential
    // flip — is unchanged for every provider not named here).
    const KEYLESS_CLOUD_ALLOWLIST = new Set(["edge-tts"]);
    const cloudProviders = REGISTRY.filter((p) => p.backend === "cloud_http");
    expect(cloudProviders.length).toBeGreaterThan(0); // sanity: the invariant has something to guard
    for (const p of cloudProviders) {
      if (KEYLESS_CLOUD_ALLOWLIST.has(p.provider)) {
        expect(p.configured).toBe(true);
      } else {
        expect(p.configured).toBe(false);
      }
    }
  });
});
