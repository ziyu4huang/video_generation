import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  selectProvider,
  rankedProviders,
  NoConfiguredProviderError,
} from "./selector.ts";
import { _setFfmpegAvailableForTest, _setRemotionProbeForTest, _setMotionFiltersForTest, _setWhisperRuntimeForTest, _setVisionRuntimeForTest, _setRunPyRuntimeForTest, _setKrea2BinaryForTest, _setFlux2BinaryForTest, _setLmStudioReachableForTest, probeConfigured } from "./providers.ts";
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
  // LM Studio reachable so mlx:caption (caption_native.ts VLM path) is callable
  // regardless of whether the host has LM Studio running.
  _setLmStudioReachableForTest(true);
});
afterAll(() => {
  _setFfmpegAvailableForTest(undefined);
  _setRemotionProbeForTest(undefined);
  _setMotionFiltersForTest(undefined);
  _setWhisperRuntimeForTest(undefined);
  _setVisionRuntimeForTest("clip", undefined);
  _setKrea2BinaryForTest(undefined);
  _setFlux2BinaryForTest(undefined);
  _setLmStudioReachableForTest(undefined);
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
    // (macos_native, always callable, and ranked above edge_tts's cloud_http
    // tier). On non-darwin CI runners say's probe is false (platform-gated),
    // but edge_tts (cloud_http, needs no key) is pinned callable by this
    // suite's beforeAll (_setRunPyRuntimeForTest(true)) — so it, not a throw,
    // is what the ranking falls back to there.
    if (process.platform === "darwin") {
      const e = selectProvider("tts", { provider: "piper", env: NO_ENV });
      expect(e.provider).toBe("say");
    } else {
      const e = selectProvider("tts", { provider: "piper", env: NO_ENV });
      expect(e.provider).toBe("edge-tts");
    }
  });

  it("cloud_http tts always resolves to edge-tts now (bun:tts-native has no run.py/venv dependency)", () => {
    // 2026-07-13: edge_tts's invoke moved from mlx:runpy-tts (probe gated on
    // the python venv) to bun:tts-native (no runtime dependency at all — the
    // default probeConfigured case just returns registry.configured=true).
    // Unpinning run.py no longer empties the cloud_http tts tier the way it
    // used to; edge-tts alone keeps it non-empty.
    _setRunPyRuntimeForTest(false);
    try {
      const e = selectProvider("tts", { env: NO_ENV, backend: "cloud_http" });
      expect(e.provider).toBe("edge-tts");
      expect(e.invoke).toBe("bun:tts-native");
    } finally {
      _setRunPyRuntimeForTest(true);
    }
  });

  it("resolves music_generation to the local MusicGen provider", () => {
    // 2026-07-26: recovered from an orphaned branch — music_generation now has
    // a registered provider (musicgen_music, run.py music via mlx-audiocraft).
    const e = selectProvider("music_generation", { env: NO_ENV });
    expect(e.provider).toBe("musicgen");
    expect(e.invoke).toBe("mlx:runpy-music");
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
    // runpy_image declares purify/multicouple/workflow/storyboard/kontext —
    // commands the Swift directors don't claim. Command routing sends them
    // to the run.py adapter with no provider hint, unlocking local
    // capabilities the agent otherwise can't reach.
    // NOTE: "twosubject" moved OFF this adapter (2026-07-13) onto twosubject_native,
    // "restore" moved OFF (2026-07-13, session 3) onto krea2_image as an i2i alias,
    // "profile" moved OFF (2026-07-13, session 4) onto profile_native,
    // "controlnet" moved OFF (2026-07-13, session 3) onto controlnet_hybrid
    // (a style-forked native/python split, not a full move), "inpaint"
    // moved OFF (2026-07-13, session 5) onto flux2_image, "faceswap"
    // moved OFF (2026-07-13, session 4) onto flux2_image, and "character"
    // moved OFF (2026-07-13, session 6) onto character_native — see the
    // dedicated tests. "multicouple" stays here permanently (genuine MLX/GPU
    // latent-couple compute, unportable).
    for (const cmd of ["multicouple"]) {
      const e = selectProvider("image_generation", { command: cmd, env: NO_ENV });
      expect(e.provider).toBe("runpy-image");
      expect(e.invoke).toBe("mlx:runpy-image");
    }
  });

  it("routes image_generation:controlnet → controlnet-hybrid (style-forked native/python dispatch)", () => {
    // 2026-07-13 session 3: swift/krea2-image-director ships a real native
    // Krea2ControlNet.swift (Control LoRA), but it's architecturally
    // different from run.py's image-controlnet.py (canny/scribble
    // preprocessing) — no drop-in replacement. The selector still routes
    // {image_generation, "controlnet"} to a single provider (controlnet_hybrid);
    // the actual native-vs-python fork happens inside bridge.ts's
    // realControlNet based on request shape (see isNativeControlNetRequest),
    // not at the selector/registry level.
    const e = selectProvider("image_generation", { command: "controlnet", env: NO_ENV });
    expect(e.provider).toBe("controlnet-hybrid");
    expect(e.invoke).toBe("mlx:controlnet-hybrid");
  });

  it("routes image_generation:twosubject → twosubject-native (pure control flow, no MLX compute)", () => {
    // 2026-07-13: image-twosubject.py is VLM prompt-master + best-of-N native t2i +
    // VLM judge — no MLX compute of its own — so it moved off run.py onto a direct
    // Bun implementation (twosubject_native.ts). Unlike multicouple's latent-couple
    // compositing (genuine MLX/GPU compute), this one is portable control flow.
    const e = selectProvider("image_generation", { command: "twosubject", env: NO_ENV });
    expect(e.provider).toBe("twosubject-native");
    expect(e.invoke).toBe("bun:twosubject-native");
  });

  it("routes image_generation:profile → profile-native (reuses the angle mechanism, already Swift-native)", () => {
    // 2026-07-13 session 4: image-profile.py's own header comments say it
    // deliberately reuses image-angle.py's mechanism (short-prompt
    // Flux2KleinEdit multi-ref) — already fully ported to Swift. Moved off
    // run.py onto a direct Bun implementation (profile_native.ts) that calls
    // flux2's native `angle` command once per requested view.
    const e = selectProvider("image_generation", { command: "profile", env: NO_ENV });
    expect(e.provider).toBe("profile-native");
    expect(e.invoke).toBe("bun:profile-native");
  });

  it("routes image_generation:character → character-native (pure orchestration of profile+segment, already Swift-native)", () => {
    // 2026-07-13 session 6: image-character.py's own header calls itself pure
    // orchestration composing two already-certified primitives — `image
    // profile` (already ported, profile_native.ts) and Step-1 `cutout` (SAM3
    // segment, already Swift-native as flux2's `segment` command). Moved off
    // run.py onto a direct Bun implementation (character_native.ts).
    const e = selectProvider("image_generation", { command: "character", env: NO_ENV });
    expect(e.provider).toBe("character-native");
    expect(e.invoke).toBe("bun:character-native");
  });

  it("routes image_generation:{angle,swap,expand,anime2real,expansion,style,scene} → flux2 (Swift-native)", () => {
    // 2026-07-13: these moved off runpy_image onto flux2's own commands.
    // anime2real/expansion are legacy run.py action-name aliases, still routed
    // here and normalized by bridge.ts's normalizeLegacyImageRequest.
    for (const cmd of ["angle", "swap", "expand", "anime2real", "expansion", "style", "scene"]) {
      const e = selectProvider("image_generation", { command: cmd, env: NO_ENV });
      expect(e.provider).toBe("flux2");
      expect(e.invoke).toBe("swift:flux2");
    }
  });

  it("routes image_generation:inpaint → flux2 (Swift-native, InpaintCommand.swift)", () => {
    // 2026-07-13 session 5: image-inpaint.py's core masked-redraw mechanism
    // (Flux2 latent-mask re-injection) was already Swift-native underneath —
    // Flux2EditPipeline.inpaint shipped for SwapCommand's `--inpaint` seamless
    // mode. Only a CLI command exposing it for an arbitrary EXTERNAL mask PNG
    // was missing; InpaintCommand.swift adds that. Moved off runpy_image onto
    // flux2_image; bridge.ts's normalizeLegacyImageRequest maps legacy
    // inputImage/referenceImage → input/reference before calling runFlux2.
    const e = selectProvider("image_generation", { command: "inpaint", env: NO_ENV });
    expect(e.provider).toBe("flux2");
    expect(e.invoke).toBe("swift:flux2");
  });

  it("routes image_generation:faceswap → flux2 (Swift-native, FaceSwapCommand.swift)", () => {
    // 2026-07-13 session 4: image-faceswap.py's real-usage path (--input/--face,
    // no --self-test) is genuine Flux2 Klein transformer compute Swift already
    // had every primitive for: FaceSwapCommand.swift combines Flux2EditPipeline's
    // multi-ref conditioning (edit/style's mechanism) with the BFS LoRA fused at
    // init time via Flux2LoRALoaderCLI (style/scene's mechanism) — never wired
    // together before. Moved off runpy_image onto flux2_image; bridge.ts's
    // normalizeLegacyImageRequest maps legacy input/face → body/face before
    // calling runFlux2. --self-test's source-synthesis/VLM-scoring/HTML-review
    // scaffolding is deliberately NOT ported (test/QA-only, not the swap itself).
    const e = selectProvider("image_generation", { command: "faceswap", env: NO_ENV });
    expect(e.provider).toBe("flux2");
    expect(e.invoke).toBe("swift:flux2");
  });

  it("routes image_generation:i2i → krea2 (Swift-native)", () => {
    const e = selectProvider("image_generation", { command: "i2i", env: NO_ENV });
    expect(e.provider).toBe("krea2");
    expect(e.invoke).toBe("swift:krea2");
  });

  it("routes image_generation:restore → krea2 (Swift-native, i2i alias)", () => {
    // 2026-07-13 session 3: image-restore.py is a thin wrapper (i2i with
    // reference_image forced None, no other overrides) — krea2's native i2i
    // has no ControlNet concept at all, so restore==i2i exactly. Moved off
    // runpy_image onto krea2_image; bridge.ts's normalizeLegacyImageRequest
    // renames the command to i2i before calling runKrea2.
    const e = selectProvider("image_generation", { command: "restore", env: NO_ENV });
    expect(e.provider).toBe("krea2");
    expect(e.invoke).toBe("swift:krea2");
  });

  it("routes enhancement:upscale → flux2 (sole upscale provider; esrgan removed 2026-07-19)", () => {
    const e = selectProvider("enhancement", { command: "upscale", env: NO_ENV });
    expect(e.provider).toBe("flux2");
    expect(e.invoke).toBe("swift:flux2");
  });

  it("routes story_generation:{angles,propose} → the direct LM Studio client, shots → run.py", () => {
    // 2026-07-13: angles/propose are pure LM Studio HTTP calls underneath (no
    // MLX compute) — moved off runpy_story onto story_native.ts. shots still
    // delegates to `image storyboard`, which has no Swift equivalent.
    for (const cmd of ["angles", "propose"]) {
      const e = selectProvider("story_generation", { command: cmd, env: NO_ENV });
      expect(e.provider).toBe("lmstudio-story");
      expect(e.invoke).toBe("bun:lmstudio-story");
    }
    const shots = selectProvider("story_generation", { command: "shots", env: NO_ENV });
    expect(shots.provider).toBe("runpy-story");
    expect(shots.invoke).toBe("mlx:runpy-story");
  });

  it("an explicit provider hint still wins over a command match", () => {
    // provider is a hard pin; command is a tiebreak below it.
    const e = selectProvider("analysis", { provider: "whisper", command: "video_understand", env: NO_ENV });
    expect(e.provider).toBe("whisper");
  });
});
