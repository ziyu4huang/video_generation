import { describe, expect, it } from "bun:test";
import {
  selectProvider,
  rankedProviders,
  NoConfiguredProviderError,
} from "./selector.ts";
import { REGISTRY, type Capability } from "./registry.ts";

describe("selectProvider", () => {
  it("picks a configured native_swift provider for image_generation", () => {
    const e = selectProvider("image_generation");
    expect(e.configured).toBe(true);
    expect(e.backend).toBe("native_swift");
    expect(["krea2", "flux2", "z-image"]).toContain(e.provider);
  });

  it("prefers native_swift over cloud/ffmpeg regardless of declaration order", () => {
    // composition has compose_ffmpeg (configured, ffmpeg) + compose_remotion (cloud, not configured).
    const e = selectProvider("composition");
    expect(e.provider).toBe("ffmpeg");
    expect(e.backend).toBe("ffmpeg");
  });

  it("an explicit provider hint wins when it names a configured provider", () => {
    const e = selectProvider("image_generation", { provider: "flux2" });
    expect(e.provider).toBe("flux2");
  });

  it("a provider hint naming a NOT-configured provider is ignored (soft hint)", () => {
    // piper is a tts provider but not configured; selectProvider must fall back
    // to ANY configured tts (none are configured → throws), rather than pin piper.
    expect(() => selectProvider("tts", { provider: "piper" })).toThrow(NoConfiguredProviderError);
  });

  it("throws NoConfiguredProviderError when nothing is wired for the capability", () => {
    // tts has only cloud (not configured) + piper (not configured).
    expect(() => selectProvider("tts")).toThrow(NoConfiguredProviderError);
    try {
      selectProvider("tts");
    } catch (err) {
      expect(err).toBeInstanceOf(NoConfiguredProviderError);
      expect((err as NoConfiguredProviderError).capability).toBe("tts");
    }
  });

  it("is deterministic — same inputs always pick the same provider", () => {
    const a = selectProvider("image_generation");
    const b = selectProvider("image_generation");
    expect(a.name).toBe(b.name);
  });

  it("rankedProviders returns configured providers best-first", () => {
    const ranked = rankedProviders("image_generation");
    expect(ranked.length).toBeGreaterThan(0);
    // Every entry is configured.
    for (const e of ranked) expect(e.configured).toBe(true);
    // Backend rank is non-decreasing.
    const ranks = ranked.map((e) =>
      e.backend === "native_swift" ? 0 : e.backend === "ffmpeg" ? 1 : e.backend === "macos_native" ? 2 : 3,
    );
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]!);
  });

  it("every Capability in the registry is selectable when at least one provider is configured", () => {
    const caps = new Set<Capability>(REGISTRY.map((p) => p.capability));
    for (const cap of caps) {
      const configured = REGISTRY.filter((p) => p.capability === cap && p.configured);
      if (configured.length === 0) {
        expect(() => selectProvider(cap)).toThrow();
      } else {
        expect(() => selectProvider(cap)).not.toThrow();
      }
    }
  });
});
