import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  selectProvider,
  rankedProviders,
  NoConfiguredProviderError,
} from "./selector.ts";
import { _setFfmpegAvailableForTest, _setRemotionProbeForTest, _setMotionFiltersForTest, _setWhisperRuntimeForTest, _setVisionRuntimeForTest, _setRunPyRuntimeForTest, _setKrea2BinaryForTest, _setFlux2BinaryForTest, probeConfigured } from "./providers.ts";
import { REGISTRY, type Capability } from "./registry.ts";

// Selector availability is runtime-probed (ffmpeg on PATH, cloud keys in env).
// Pin ffmpeg-present + remotion-absent + motion-filters-absent + whisper/clip
// runtimes present + empty env so tests are deterministic regardless of host:
// compose_ffmpeg stays the top composition backend and BOTH analysis providers
// are callable (a dev box with remotion/motion filters or no whisper-venv would
// otherwise flip the pick / make the command-routing tests host-dependent).
beforeAll(() => {
  _setFfmpegAvailableForTest(true);
  _setRemotionProbeForTest(false);
  _setMotionFiltersForTest(false);
  _setWhisperRuntimeForTest(true);
  _setVisionRuntimeForTest("clip", true);
  _setVisionRuntimeForTest("esrgan", true);
  // Pin the swift image-director binaries present so the default image_generation
  // pick stays deterministic (krea2, first-declared native_swift) regardless of
  // whether this host has built the swift binaries — the probe now checks the
  // real binary, so without a pin a fresh CI host would reroute to runpy-image.
  _setKrea2BinaryForTest(true);
  _setFlux2BinaryForTest(true);
  // run.py runtime present so mlx:runpy / mlx:runpy-image are callable regardless
  // of whether this host has recreated python/venv (keeps the command-routing +
  // capability-coverage tests host-independent).
  _setRunPyRuntimeForTest(true);
});
afterAll(() => {
  _setFfmpegAvailableForTest(undefined);
  _setRemotionProbeForTest(undefined);
  _setMotionFiltersForTest(undefined);
  _setWhisperRuntimeForTest(undefined);
  _setVisionRuntimeForTest("clip", undefined);
  _setVisionRuntimeForTest("esrgan", undefined);
  _setKrea2BinaryForTest(undefined);
  _setFlux2BinaryForTest(undefined);
  _setRunPyRuntimeForTest(undefined);
});

const NO_ENV: Record<string, string | undefined> = {};

describe("selectProvider", () => {
  it("picks a configured native_swift provider for image_generation", () => {
    const e = selectProvider("image_generation", { env: NO_ENV });
    expect(e.backend).toBe("native_swift");
    expect(["krea2", "flux2", "z-image"]).toContain(e.provider);
  });

  it("prefers native_swift over cloud/ffmpeg regardless of declaration order", () => {
    // composition: compose_ffmpeg (ffmpeg, probe-true here) is the top backend.
    const e = selectProvider("composition", { env: NO_ENV });
    expect(e.provider).toBe("ffmpeg");
    expect(e.backend).toBe("ffmpeg");
  });

  it("an explicit provider hint wins when it names a configured provider", () => {
    const e = selectProvider("image_generation", { provider: "flux2", env: NO_ENV });
    expect(e.provider).toBe("flux2");
  });

  it("a provider hint naming a NOT-configured provider is ignored (soft hint)", () => {
    // piper is a GAP (never callable); the hint is ignored and falls back to the
    // probe-based ranking. On darwin that lands on the macOS `say` fallback
    // (macos_native, always callable); on non-darwin CI runners say's probe is
    // false too and tts has nothing else configured (no cloud keys) → throws.
    if (process.platform === "darwin") {
      const e = selectProvider("tts", { provider: "piper", env: NO_ENV });
      expect(e.provider).toBe("say");
    } else {
      expect(() => selectProvider("tts", { provider: "piper", env: NO_ENV })).toThrow(NoConfiguredProviderError);
    }
  });

  it("throws NoConfiguredProviderError when nothing is wired for the capability", () => {
    // tts as a whole always resolves to the local `say` fallback on darwin now;
    // isolate to the cloud_http backend (unkeyed) to exercise the "nothing
    // wired" path without say's macos_native fallback masking it.
    expect(() => selectProvider("tts", { env: NO_ENV, backend: "cloud_http" })).toThrow(NoConfiguredProviderError);
    try {
      selectProvider("tts", { env: NO_ENV, backend: "cloud_http" });
    } catch (err) {
      expect(err).toBeInstanceOf(NoConfiguredProviderError);
      expect((err as NoConfiguredProviderError).capability).toBe("tts");
    }
  });

  it("a cloud provider becomes callable when its key is in env (probe upgrade)", () => {
    // With OPENAI_API_KEY set, openai_tts is callable within its own backend
    // class (isolated from say's macos_native fallback, which otherwise wins
    // the unrestricted tts ranking on darwin).
    const env = { OPENAI_API_KEY: "sk-test" };
    const e = selectProvider("tts", { env, backend: "cloud_http" });
    expect(e.provider).toBe("openai");
    expect(e.backend).toBe("cloud_http");
  });

  it("ffmpeg providers drop out when ffmpeg is absent (probe downgrade)", () => {
    _setFfmpegAvailableForTest(false);
    try {
      expect(() => selectProvider("composition", { env: NO_ENV })).toThrow(NoConfiguredProviderError);
    } finally {
      _setFfmpegAvailableForTest(true);
    }
  });

  it("is deterministic — same inputs always pick the same provider", () => {
    const a = selectProvider("image_generation", { env: NO_ENV });
    const b = selectProvider("image_generation", { env: NO_ENV });
    expect(a.name).toBe(b.name);
  });

  it("rankedProviders returns callable providers best-first", () => {
    const ranked = rankedProviders("image_generation", NO_ENV);
    expect(ranked.length).toBeGreaterThan(0);
    const ranks = ranked.map((e) =>
      e.backend === "native_swift" ? 0 : e.backend === "ffmpeg" ? 1 : e.backend === "macos_native" ? 2 : 3,
    );
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]!);
  });

  it("every Capability is selectable iff at least one provider's probe passes", () => {
    // Delegates to the REAL probeConfigured (with the beforeAll pins applied)
    // rather than a hand-rolled mirror — a duplicated mirror silently drifts
    // whenever providers.ts gains a new invoke case (this bit us for
    // bun:esrgan/macos:vision when the honest-probe pass landed: the mirror
    // still said "configured ⇒ callable" while the real probe now requires a
    // pinned runtime / darwin platform, so it disagreed with reality on Linux CI).
    const caps = new Set<Capability>(REGISTRY.map((p) => p.capability));
    for (const cap of caps) {
      const anyCallable = REGISTRY.filter((p) => p.capability === cap).some((p) => probeConfigured(p, NO_ENV));
      if (anyCallable) {
        expect(() => selectProvider(cap, { env: NO_ENV })).not.toThrow();
      } else {
        expect(() => selectProvider(cap, { env: NO_ENV })).toThrow();
      }
    }
  });
});

// Command routing (Item B): {capability:"analysis", command:"video_understand"}
// must reach CLIP without a provider hint. whisper and clip are both native_swift,
// whisper declared first → the prior backend-then-declaration tiebreak always
// picked whisper. A command a provider owns now outranks that tie.
describe("selectProvider command routing", () => {
  it("routes analysis:video_understand → clip with no provider hint", () => {
    const e = selectProvider("analysis", { command: "video_understand", env: NO_ENV });
    expect(e.provider).toBe("clip");
    expect(e.invoke).toBe("bun:clip");
  });

  it("routes analysis:transcribe → whisper with no provider hint", () => {
    const e = selectProvider("analysis", { command: "transcribe", env: NO_ENV });
    expect(e.provider).toBe("whisper");
    expect(e.invoke).toBe("bun:whisper");
  });

  it("a command no provider declares falls back to the backend-rank pick (soft)", () => {
    // image_generation's Swift directors don't declare `commands`, and runpy_image
    // does NOT claim "t2i" (basic t2i/i2i stay on the Swift directors). So an
    // unclaimed command like "t2i" must NOT change behavior — the pick matches the
    // command-less selector (krea2, the first-declared native_swift director).
    const withCmd = selectProvider("image_generation", { command: "t2i", env: NO_ENV });
    const noCmd = selectProvider("image_generation", { env: NO_ENV });
    expect(withCmd.name).toBe(noCmd.name);
  });

  it("routes image_generation:<run.py-only command> → runpy-image (the force multiplier)", () => {
    // runpy_image declares controlnet/faceswap/swap/anime2real/profile/angle/purify/
    // restore/multicouple/twosubject/workflow/expansion/i2i — commands the Swift
    // directors don't claim. Command routing sends them to the run.py adapter with
    // no provider hint, unlocking ~15 local capabilities the agent otherwise can't reach.
    for (const cmd of ["controlnet", "faceswap", "profile", "twosubject", "swap"]) {
      const e = selectProvider("image_generation", { command: cmd, env: NO_ENV });
      expect(e.provider).toBe("runpy-image");
      expect(e.invoke).toBe("mlx:runpy-image");
    }
  });

  it("an explicit provider hint still wins over a command match", () => {
    // provider is a hard pin; command is a tiebreak below it.
    const e = selectProvider("analysis", { provider: "whisper", command: "video_understand", env: NO_ENV });
    expect(e.provider).toBe("whisper");
  });
});
