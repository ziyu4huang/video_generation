import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSubtitle,
  subtitleAdapter,
  ffmpegAdapter,
  cloudHttpAdapter,
  probeConfigured,
  probedMenuSummary,
  whisperAdapter,
  cuesFromWhisper,
  clipAdapter,
  _setFfmpegAvailableForTest,
  _setRemotionProbeForTest,
  _setMotionFiltersForTest,
  _setWhisperRuntimeForTest,
  _setVisionRuntimeForTest,
  _setFlux2BinaryForTest,
  _setLmStudioReachableForTest,
  _setHyperframesCliForTest,
  type WhisperResult,
  type ClipResult,
} from "./providers.ts";
import { REGISTRY } from "./registry.ts";

beforeAll(() => {
  _setFfmpegAvailableForTest(true);
  _setRemotionProbeForTest(false);
  _setMotionFiltersForTest(true);
  _setWhisperRuntimeForTest(true);
  _setVisionRuntimeForTest("clip", true);
  // Pin the swift flux2 binary present so upscale_flux2 (the sole enhancement:upscale
  // provider after the esrgan removal) is callable on every CI runner regardless of
  // platform / whether the swift binary was built. bg_remove (macos:vision) is
  // darwin-only, so without this pin enhancement would be a gap on Linux CI.
  _setFlux2BinaryForTest(true);
  _setLmStudioReachableForTest(true);
  // bunx ships with bun itself, so this is genuinely true on every runner —
  // pinned anyway for the same determinism reason as the others (never trust
  // real PATH state in a unit test).
  _setHyperframesCliForTest(true);
});
afterAll(() => {
  _setFfmpegAvailableForTest(undefined);
  _setRemotionProbeForTest(undefined);
  _setMotionFiltersForTest(undefined);
  _setWhisperRuntimeForTest(undefined);
  _setVisionRuntimeForTest("clip", undefined);
  _setFlux2BinaryForTest(undefined);
  _setLmStudioReachableForTest(undefined);
  _setHyperframesCliForTest(undefined);
});

describe("buildSubtitle (pure)", () => {
  it("formats SRT with 1-based indices + comma ms separator", () => {
    const srt = buildSubtitle({
      cues: [
        { text: "hello", start: 0, end: 1.5 },
        { text: "world", start: 1.5, end: 2.25 },
      ],
    });
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,500\nhello");
    expect(srt).toContain("2\n00:00:01,500 --> 00:00:02,250\nworld");
  });

  it("formats VTT with WEBVTT header + dot ms separator + speaker tag", () => {
    const vtt = buildSubtitle({
      format: "vtt",
      cues: [{ text: "hi", start: 0, end: 1, speaker: "Alice" }],
    });
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:01.000");
    expect(vtt).toContain("<v Alice>hi");
  });

  it("empty cues → empty SRT / header-only VTT", () => {
    expect(buildSubtitle({ cues: [] })).toBe("");
    expect(buildSubtitle({ format: "vtt", cues: [] })).toBe("WEBVTT\n");
  });

  it("zero-pads hours + minutes + milliseconds", () => {
    const srt = buildSubtitle({ cues: [{ text: "x", start: 3661.5, end: 3662.999 }] });
    expect(srt).toContain("01:01:01,500 --> 01:01:02,999");
  });
});

describe("subtitleAdapter", () => {
  it("writes an SRT file and returns a well-formed ToolResult", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-sub-"));
    try {
      const r = await subtitleAdapter({
        capability: "subtitle",
        command: "srt",
        outputDir: dir,
        options: { cues: [{ text: "a", start: 0, end: 1 }] },
      });
      expect(r.success).toBe(true);
      expect(r.provider).toBe("openmontage");
      expect(r.artifacts).toHaveLength(1);
      expect(r.artifacts[0]!.kind).toBe("data");
      expect(existsSync(r.artifacts[0]!.path)).toBe(true);
      expect(readFileSync(r.artifacts[0]!.path, "utf8")).toContain("00:00:00,000 --> 00:00:01,000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives cues from a whisper wordsPath (agent-driven captions path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-sub-words-"));
    try {
      const wordsPath = join(dir, "words.json");
      writeFileSync(
        wordsPath,
        JSON.stringify({
          language: "en",
          segments: [
            {
              start: 0,
              end: 2,
              text: "hello world",
              words: [
                { word: "hello", start: 0, end: 1 },
                { word: "world", start: 1, end: 2 },
              ],
            },
          ],
        }),
        "utf8",
      );
      const r = await subtitleAdapter({
        capability: "subtitle",
        command: "srt",
        outputDir: dir,
        options: { wordsPath, wordsPerCue: 2 },
      });
      expect(r.success).toBe(true);
      const srt = readFileSync(r.artifacts[0]!.path, "utf8");
      expect(srt).toContain("hello world");
      expect(srt).toContain("00:00:00,000 --> 00:00:02,000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails cleanly when wordsPath does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-sub-missing-"));
    try {
      const r = await subtitleAdapter({
        capability: "subtitle",
        command: "srt",
        outputDir: dir,
        options: { wordsPath: join(dir, "nope.json") },
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain("wordsPath not found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("probeConfigured + probedMenuSummary", () => {
  const NO_ENV: Record<string, string | undefined> = {};

  it("ffmpeg provider reflects pinned ffmpeg availability", () => {
    const compose = REGISTRY.find((p) => p.name === "compose_ffmpeg")!;
    expect(probeConfigured(compose, NO_ENV)).toBe(true);
    _setFfmpegAvailableForTest(false);
    try {
      expect(probeConfigured(compose, NO_ENV)).toBe(false);
    } finally {
      _setFfmpegAvailableForTest(true);
    }
  });

  it("cloud provider upgrades to callable when its key is present", () => {
    const openai = REGISTRY.find((p) => p.name === "openai_tts")!;
    expect(probeConfigured(openai, NO_ENV)).toBe(false);
    expect(probeConfigured(openai, { OPENAI_API_KEY: "sk-test" })).toBe(true);
  });

  it("an unconfigured/GAP entry is never callable regardless of backend", () => {
    // piper_tts: configured:false (a documented gap) → not callable, no key helps.
    const piper = REGISTRY.find((p) => p.name === "piper_tts")!;
    expect(piper.configured).toBe(false);
    expect(probeConfigured(piper, NO_ENV)).toBe(false);
    expect(probeConfigured(piper, { PIPER_KEY: "x" })).toBe(false);
    // transcriber: NOW configured (Item I wired the mlx-whisper backend).
    const transcriber = REGISTRY.find((p) => p.name === "transcriber")!;
    expect(transcriber.configured).toBe(true);
    expect(transcriber.invoke).toBe("bun:whisper");
    // callable iff the whisper runtime probe passes (test-pinned true above).
    expect(probeConfigured(transcriber, NO_ENV)).toBe(true);
    _setWhisperRuntimeForTest(false);
    try {
      expect(probeConfigured(transcriber, NO_ENV)).toBe(false);
    } finally {
      _setWhisperRuntimeForTest(true);
    }
  });

  it("analysis + enhancement providers are no longer gaps (Item I siblings)", () => {
    const m = probedMenuSummary(NO_ENV);
    const gapNames = m.gaps.map((g) => g.name);
    expect(gapNames).not.toContain("transcriber");
    expect(gapNames).not.toContain("video_understand");
    expect(gapNames).not.toContain("upscale");
    // analysis capability: whisper + clip both wired.
    const analysis = m.capabilities.find((c) => c.capability === "analysis")!;
    expect(analysis.available_providers).toContain("whisper");
    expect(analysis.available_providers).toContain("clip");
    // enhancement capability: upscale via flux2 (the sole upscale provider since
    // the esrgan adapter was removed 2026-07-19); bg_remove (macos:vision) is
    // darwin-only, so flux2 is the platform-independent guarantee here.
    const enhancement = m.capabilities.find((c) => c.capability === "enhancement")!;
    expect(enhancement.available_providers).toContain("flux2");
  });

  it("probedMenuSummary reports callable providers per capability", () => {
    const m = probedMenuSummary(NO_ENV);
    const caps = m.capabilities.map((c) => c.capability);
    expect(caps).toContain("image_generation");
    expect(caps).toContain("subtitle");
    // subtitle_gen (bun:builtin, non-gap) is callable.
    const sub = m.capabilities.find((c) => c.capability === "subtitle")!;
    expect(sub.available_providers).toContain("openmontage");
  });

  it("compose_remotion is reclassified (Item A): callable iff binary resolves", () => {
    const remotion = REGISTRY.find((p) => p.name === "compose_remotion")!;
    // The drift fix: native_swift + compose:remotion + configured (was cloud_http/fetch/false).
    expect(remotion.configured).toBe(true);
    expect(remotion.backend).toBe("native_swift");
    expect(remotion.invoke).toBe("compose:remotion");
    // Default (probe-pinned false): not callable, so it lists under unavailable.
    expect(probeConfigured(remotion, NO_ENV)).toBe(false);
    // Binary resolves (REMOTION_BIN points at a real file) → callable.
    const env = { REMOTION_BIN: process.execPath }; // a real binary on disk
    _setRemotionProbeForTest(undefined); // re-evaluate against env
    try {
      expect(probeConfigured(remotion, env)).toBe(true);
    } finally {
      _setRemotionProbeForTest(false); // restore the deterministic default
    }
  });

  it("Item A acceptance: composition has ZERO gaps once remotion resolves too", () => {
    // When remotion resolves (motion/ffmpeg/hyperframes are pinned available in
    // beforeAll already), all four composition providers are callable — the
    // former standing hyperframes GAP was closed 2026-08-08 (hyperframes_native.ts).
    _setRemotionProbeForTest(true);
    try {
      const m = probedMenuSummary(NO_ENV);
      const composition = m.capabilities.find((c) => c.capability === "composition")!;
      expect(composition.available_providers).toContain("remotion");
      expect(composition.available_providers).toContain("ffmpeg");
      expect(composition.available_providers).toContain("motion");
      expect(composition.available_providers).toContain("hyperframes");
      expect(composition.unavailable_providers).toEqual([]);
      // composition_runtimes rollup reflects the same truth.
      expect(m.composition_runtimes.remotion).toBe(true);
      expect(m.composition_runtimes.motion).toBe(true);
      expect(m.composition_runtimes.hyperframes).toBe(true);
    } finally {
      _setRemotionProbeForTest(false);
    }
  });

  it("Item J: compose_motion is callable iff ffmpeg + zoompan/xfade filters resolve", () => {
    const motion = REGISTRY.find((p) => p.name === "compose_motion")!;
    expect(motion.configured).toBe(true);
    expect(motion.backend).toBe("ffmpeg");
    expect(motion.invoke).toBe("compose:motion");
    // ffmpeg present + motion filters present (test-pinned true) → callable.
    expect(probeConfigured(motion, NO_ENV)).toBe(true);
    // motion filters absent → not callable even with ffmpeg present.
    _setMotionFiltersForTest(false);
    try {
      expect(probeConfigured(motion, NO_ENV)).toBe(false);
    } finally {
      _setMotionFiltersForTest(true);
    }
    // ffmpeg absent → not callable even with filters present.
    _setFfmpegAvailableForTest(false);
    try {
      expect(probeConfigured(motion, NO_ENV)).toBe(false);
    } finally {
      _setFfmpegAvailableForTest(true);
    }
  });

  it("compose_hyperframes is callable iff the hyperframes CLI resolves (HYPERFRAMES_BIN or bunx)", () => {
    const hf = REGISTRY.find((p) => p.name === "compose_hyperframes")!;
    expect(hf.configured).toBe(true);
    expect(hf.backend).toBe("native_swift");
    expect(hf.invoke).toBe("compose:hyperframes");
    expect(hf.notes!.startsWith("GAP")).toBe(false);
    // CLI present (test-pinned true in beforeAll) → callable.
    expect(probeConfigured(hf, NO_ENV)).toBe(true);
    // CLI absent → not callable, and it reappears in the GAP rollup.
    _setHyperframesCliForTest(false);
    try {
      expect(probeConfigured(hf, NO_ENV)).toBe(false);
      const m = probedMenuSummary(NO_ENV);
      expect(m.gaps.map((g) => g.name)).not.toContain("compose_hyperframes"); // GAP is a static-notes signal, not probe-driven
    } finally {
      _setHyperframesCliForTest(true);
    }
  });
});

describe("ffmpegAdapter (real ffmpeg smoke)", () => {
  it("trims a generated test clip into a real MP4", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-ff-"));
    try {
      // Generate a 2s test source with ffmpeg's lavfi (no input file needed).
      const src = join(dir, "src.mp4");
      const gen = await spawnCode("ffmpeg", [
        "-f", "lavfi", "-i", "testsrc=duration=2:size=160x120:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", src,
      ]);
      if (gen !== 0 || !existsSync(src)) {
        // ffmpeg build lacks an encoder in this env → skip, not fail.
        console.warn("ffmpeg smoke: source gen failed, skipping");
        return;
      }
      const out = join(dir, "trim.mp4");
      const r = await ffmpegAdapter({
        capability: "video_post",
        command: "trim",
        outputDir: dir,
        options: { operation: "trim", inputs: [src], output: out, start: 0, duration: 1 },
      });
      expect(r.success).toBe(true);
      expect(r.provider).toBe("ffmpeg");
      expect(r.artifacts).toHaveLength(1);
      expect(r.artifacts[0]!.kind).toBe("video");
      expect(existsSync(r.artifacts[0]!.path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails cleanly when ffmpeg is absent", async () => {
    _setFfmpegAvailableForTest(false);
    try {
      const r = await ffmpegAdapter({ capability: "video_post", command: "trim", options: {} });
      expect(r.success).toBe(false);
      expect(r.error).toContain("ffmpeg not found");
    } finally {
      _setFfmpegAvailableForTest(true);
    }
  });
});

describe("cloudHttpAdapter (mocked fetch)", () => {
  it("synthesizes audio via a mocked fetch and writes the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-cloud-"));
    try {
      const fakeFetch = (async (_url: string, _init?: unknown) => {
        const body = new Uint8Array([1, 2, 3, 4]);
        return { ok: true, status: 200, arrayBuffer: async () => body.buffer };
      }) as unknown as typeof fetch;
      const out = join(dir, "tts.mp3");
      const r = await cloudHttpAdapter(
        {
          capability: "tts",
          command: "tts",
          outputDir: dir,
          options: { provider: "openai", text: "hello world", output: out, _fetch: fakeFetch },
        },
        { OPENAI_API_KEY: "sk-test" },
      );
      expect(r.success).toBe(true);
      expect(r.provider).toBe("openai");
      expect(r.artifacts[0]!.kind).toBe("audio");
      expect(r.artifacts[0]!.bytes).toBe(4);
      expect(existsSync(out)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails cleanly when the API key is missing", async () => {
    const r = await cloudHttpAdapter(
      { capability: "tts", command: "tts", options: { provider: "openai", text: "x" } },
      {},
    );
    expect(r.success).toBe(false);
    expect(r.error).toContain("OPENAI_API_KEY");
  });
});

// ─── whisper adapter (Item I) ─────────────────────────────────────────────────

const FIXTURE_RESULT: WhisperResult = {
  ok: true,
  audio: "/tmp/narration.m4a",
  model: "mlx-community/whisper-small-mlx",
  language: "en",
  duration_s: 1.27,
  text: "Welcome to the movie director pipeline.",
  segments: [
    {
      start: 0,
      end: 2.5,
      text: "Welcome to the movie director pipeline.",
      words: [
        { word: "Welcome", start: 0, end: 0.5, prob: 0.9 },
        { word: "to", start: 0.5, end: 0.6, prob: 0.95 },
        { word: "the", start: 0.6, end: 0.7, prob: 0.99 },
        { word: "movie", start: 0.7, end: 1.1, prob: 0.97 },
        { word: "director", start: 1.1, end: 1.6, prob: 0.96 },
        { word: "pipeline.", start: 1.6, end: 2.5, prob: 0.94 },
      ],
    },
  ],
};

describe("cuesFromWhisper (pure)", () => {
  it("segments mode → one cue per segment", () => {
    const cues = cuesFromWhisper(FIXTURE_RESULT, "segments");
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("Welcome to the movie director pipeline.");
    expect(cues[0]!.start).toBe(0);
    expect(cues[0]!.end).toBe(2.5);
  });
  it("words mode → groups every N words into a cue", () => {
    const cues = cuesFromWhisper(FIXTURE_RESULT, "words", 3);
    expect(cues).toHaveLength(2); // 6 words / 3 per cue
    expect(cues[0]!.text).toBe("Welcome to the");
    expect(cues[0]!.start).toBe(0);
    expect(cues[0]!.end).toBe(0.7);
    expect(cues[1]!.text).toBe("movie director pipeline.");
  });
  it("empty result → no cues", () => {
    expect(cuesFromWhisper({ ok: true, segments: [] })).toEqual([]);
    expect(cuesFromWhisper({ ok: true })).toEqual([]);
  });
});

describe("whisperAdapter (mocked spawn)", () => {
  it("writes transcript.txt + words.json and returns a well-formed ToolResult", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-whisper-"));
    try {
      // Mock spawn: write the normalized JSON to the --output path, return 0.
      const mockSpawn = async (_cmd: string, argv: string[]): Promise<number> => {
        const outIdx = argv.indexOf("--output");
        if (outIdx >= 0) writeFileSync(argv[outIdx + 1]!, JSON.stringify(FIXTURE_RESULT, null, 2));
        return 0;
      };
      const audio = join(dir, "narration.m4a");
      writeFileSync(audio, "fake"); // adapter checks existence, not content
      const r = await whisperAdapter({
        capability: "analysis",
        command: "transcribe",
        outputDir: dir,
        options: { audio, model: "mlx-community/whisper-small-mlx", _spawnImpl: mockSpawn },
      });
      expect(r.success).toBe(true);
      expect(r.provider).toBe("whisper");
      expect(r.command).toBe("transcribe");
      expect(r.cost_usd).toBe(0); // local MLX — honest $0
      expect(r.model).toBe("mlx-community/whisper-small-mlx");
      expect(r.artifacts).toHaveLength(2);
      const roles = r.artifacts.map((a) => a.role).sort();
      expect(roles).toEqual(["transcript", "word-timestamps"]);
      const transcriptPath = r.artifacts.find((a) => a.role === "transcript")!.path;
      expect(readFileSync(transcriptPath, "utf8").trim()).toBe("Welcome to the movie director pipeline.");
      const wordsPath = r.artifacts.find((a) => a.role === "word-timestamps")!.path;
      const words = JSON.parse(readFileSync(wordsPath, "utf8")) as WhisperResult;
      expect(words.segments?.[0]?.words).toHaveLength(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails cleanly when the audio file is missing", async () => {
    const r = await whisperAdapter({
      capability: "analysis",
      command: "transcribe",
      options: { audio: "/no/such.m4a" },
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("audio missing");
  });

  it("fails cleanly when the runtime probe is off", async () => {
    _setWhisperRuntimeForTest(false);
    try {
      const r = await whisperAdapter({
        capability: "analysis",
        command: "transcribe",
        options: { audio: "/tmp/anything" },
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain("whisper backend not found");
    } finally {
      _setWhisperRuntimeForTest(true);
    }
  });

  it("default outputDir is a per-call temp dir, NOT the repo root (fold-in)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-whisper-default-"));
    try {
      const mockSpawn = async (_cmd: string, argv: string[]): Promise<number> => {
        const outIdx = argv.indexOf("--output");
        if (outIdx >= 0) writeFileSync(argv[outIdx + 1]!, JSON.stringify(FIXTURE_RESULT, null, 2));
        return 0;
      };
      const audio = join(dir, "narration.m4a");
      writeFileSync(audio, "fake");
      // NOTE: no outputDir on the request — the agent-driven shape.
      const r = await whisperAdapter({
        capability: "analysis",
        command: "transcribe",
        options: { audio, _spawnImpl: mockSpawn },
      });
      expect(r.success).toBe(true);
      const transcriptPath = r.artifacts.find((a) => a.role === "transcript")!.path;
      // The transcript lands in a per-call temp dir under os.tmpdir(), never cwd.
      expect(transcriptPath.startsWith(tmpdir())).toBe(true);
      expect(transcriptPath).not.toContain(process.cwd());
      expect(existsSync(transcriptPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── clip adapter (Item I sibling) ────────────────────────────────────────────

const CLIP_RESULT: ClipResult = {
  ok: true,
  video: null,
  prompt: "a green screen",
  labels: ["a green screen", "a red screen"],
  score: 0.277,
  prob_mean: 0.97,
  frames: [
    { path: "/tmp/f0.png", index: 0, score: 0.277, prob: 0.97 },
    { path: "/tmp/f1.png", index: 1, score: 0.277, prob: 0.97 },
  ],
  model: "openai/clip-vit-base-patch32",
  duration_s: 0.87,
};

describe("clipAdapter (mocked spawn)", () => {
  it("spawns the swift clip binary on pre-sampled frames and returns a scored ToolResult", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-clip-"));
    try {
      // Two pre-sampled frame files (adapter checks existence).
      const f0 = join(dir, "f0.png");
      const f1 = join(dir, "f1.png");
      writeFileSync(f0, "fake");
      writeFileSync(f1, "fake");
      const mockSpawn = async (_cmd: string, argv: string[]): Promise<number> => {
        const outIdx = argv.indexOf("--output");
        if (outIdx >= 0) writeFileSync(argv[outIdx + 1]!, JSON.stringify(CLIP_RESULT, null, 2));
        return 0;
      };
      const r = await clipAdapter({
        capability: "analysis",
        command: "video_understand",
        outputDir: dir,
        options: { prompt: "a green screen", frames: [f0, f1], labels: ["a red screen"], _spawnImpl: mockSpawn },
      });
      expect(r.success).toBe(true);
      expect(r.provider).toBe("clip");
      expect(r.command).toBe("video_understand");
      expect(r.cost_usd).toBe(0); // local torch MPS — honest $0
      expect(r.model).toBe("openai/clip-vit-base-patch32");
      // scores artifact + 2 frame artifacts (frames given directly → surfaced).
      const roles = r.artifacts.map((a) => a.role).sort();
      expect(roles).toEqual(["frame-0", "frame-1", "scores"]);
      const scores = JSON.parse(readFileSync(r.artifacts.find((a) => a.role === "scores")!.path, "utf8")) as ClipResult;
      expect(scores.score).toBe(0.277);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails cleanly when prompt is missing", async () => {
    const r = await clipAdapter({
      capability: "analysis",
      command: "video_understand",
      options: { frames: ["/tmp/x.png"] } as Record<string, unknown>,
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("prompt is required");
  });

  it("fails cleanly when no frames and no video", async () => {
    const r = await clipAdapter({
      capability: "analysis",
      command: "video_understand",
      options: { prompt: "x" },
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("no frames");
  });

  it("fails cleanly when the runtime probe is off", async () => {
    _setVisionRuntimeForTest("clip", false);
    try {
      const r = await clipAdapter({
        capability: "analysis",
        command: "video_understand",
        options: { prompt: "x", frames: ["/tmp/anything.png"] },
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain("clip backend not found");
    } finally {
      _setVisionRuntimeForTest("clip", true);
    }
  });

  it("default outputDir is a per-call temp dir, NOT the repo root (fold-in)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-clip-default-"));
    try {
      const f0 = join(dir, "f0.png");
      const f1 = join(dir, "f1.png");
      writeFileSync(f0, "fake");
      writeFileSync(f1, "fake");
      const mockSpawn = async (_cmd: string, argv: string[]): Promise<number> => {
        const outIdx = argv.indexOf("--output");
        if (outIdx >= 0) writeFileSync(argv[outIdx + 1]!, JSON.stringify(CLIP_RESULT, null, 2));
        return 0;
      };
      // NOTE: no outputDir on the request — the agent-driven shape (live evidence:
      // the CLIP agent run littered the repo root with clip_scores.json + frames).
      const r = await clipAdapter({
        capability: "analysis",
        command: "video_understand",
        options: { prompt: "a green screen", frames: [f0, f1], _spawnImpl: mockSpawn },
      });
      expect(r.success).toBe(true);
      const scoresPath = r.artifacts.find((a) => a.role === "scores")!.path;
      expect(scoresPath.startsWith(tmpdir())).toBe(true);
      expect(scoresPath).not.toContain(process.cwd());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("compose adapters enforce the pre-compose gate (regression: was a second ungated entry point)", () => {
  // composeRemotionAdapter/composeMotionAdapter delegate to renderRemotion()/
  // composeMotion() directly, the same calls the gated `compose-remotion`/
  // `compose-motion` dispatch commands make — but historically without ever
  // calling enforcePreCompose. An empty cuts array fails preComposeGate's
  // cuts_present check; both adapters must refuse before touching the render
  // call, not attempt (and fail differently) inside it.
  it("composeRemotionAdapter refuses a fail-verdict edit before calling renderRemotion", async () => {
    const { composeRemotionAdapter } = await import("./providers.ts");
    const result = await composeRemotionAdapter({
      capability: "composition",
      command: "compose-remotion",
      outputDir: tmpdir(),
      options: { editDecisions: { version: "1.0", cuts: [] } },
    });
    expect(result.success).toBe(false);
    expect(result.provider).toBe("remotion");
    expect(result.error).toBeTruthy();
  });

  it("composeMotionAdapter refuses a fail-verdict edit before calling composeMotion", async () => {
    const { composeMotionAdapter } = await import("./providers.ts");
    const result = await composeMotionAdapter({
      capability: "composition",
      command: "compose-motion",
      outputDir: tmpdir(),
      options: { editDecisions: { version: "1.0", cuts: [] } },
    });
    expect(result.success).toBe(false);
    expect(result.provider).toBe("motion");
    expect(result.error).toBeTruthy();
  });

  it("composeMotionAdapter proceeds when overridePreCompose:true bypasses a fail verdict", async () => {
    const { composeMotionAdapter } = await import("./providers.ts");
    // Still no real cuts to render, so composeMotion() itself will fail — the
    // point here is only that it gets PAST the gate (a different failure mode
    // than "gate refused"), proving the override plumbing reaches the gate.
    const result = await composeMotionAdapter({
      capability: "composition",
      command: "compose-motion",
      outputDir: tmpdir(),
      options: { editDecisions: { version: "1.0", cuts: [] }, overridePreCompose: true },
    });
    expect(result.success).toBe(false);
    expect(result.provider).toBe("motion");
    // Distinguish "gate refused" (would be preComposeCheck.error, a
    // gate-shaped message) from "composeMotion attempted and failed" by
    // asserting we did NOT get the gate's own cuts_present wording.
    expect(result.error ?? "").not.toContain("cuts_present");
  });
});

describe("composeMotionAdapter forwards captions (regression: was silently dropped)", () => {
  // The adapter once omitted opts.captions when calling composeMotion(), so the
  // local ffmpeg composition path could never burn subtitles even though the
  // underlying compositor supports the libass → drawtext → sidecar ladder. This
  // guards the forwarding by injecting a spawn and asserting a drawtext burn pass
  // actually runs when captions:{burn:true} is supplied.
  it("runs a drawtext captions burn pass when options.captions is supplied", async () => {
    const { _setSubtitlesFilterForTest, _setDrawtextFilterForTest, _setCaptionFontForTest } = await import("./captions.ts");
    const { composeMotionAdapter } = await import("./providers.ts");
    _setSubtitlesFilterForTest(false); // force the drawtext tier
    _setDrawtextFilterForTest(true);
    _setCaptionFontForTest("/System/Library/Fonts/Supplemental/Arial.ttf");
    try {
      const dir = mkdtempSync(join(tmpdir(), "md-moca-"));
      try {
        const src = join(dir, "src.mp4");
        const srt = join(dir, "c.srt");
        writeFileSync(src, "x");
        writeFileSync(srt, "1\n00:00:00,500 --> 00:00:01,500\nlocal motion caption\n");
        const calls: { cmd: string; argv: string[] }[] = [];
        const spawnImpl = async (cmd: string, argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
          calls.push({ cmd, argv });
          if (cmd === "ffprobe") {
            if (argv.includes("-show_streams")) {
              return {
                code: 0,
                stdout: JSON.stringify({
                  format: { duration: "2.0", format_name: "mov,mp4" },
                  streams: [
                    { codec_type: "video", codec_name: "h264", width: 512, height: 512, avg_frame_rate: "24/1" },
                    { codec_type: "audio", codec_name: "aac" },
                  ],
                }),
                stderr: "",
              };
            }
            return { code: 0, stdout: "2.0\n", stderr: "" };
          }
          // Any ffmpeg call: write a placeholder to its output path (last argv).
          const out = argv[argv.length - 1];
          if (out) writeFileSync(out, "x");
          return { code: 0, stdout: "", stderr: "" };
        };
        const result = await composeMotionAdapter({
          capability: "composition",
          command: "compose-motion",
          outputDir: dir,
          options: {
            output: join(dir, "out.mp4"),
            width: 512,
            height: 512,
            fps: 24,
            editDecisions: {
              version: "1.0",
              transition: "none",
              cuts: [{ id: "a", type: "media", source: src, in_seconds: 0, out_seconds: 2, animation: "ken-burns" }],
            },
            captions: { srtPath: srt, burn: true },
            _spawnImpl: spawnImpl,
          },
        });
        expect(result.success).toBe(true);
        expect(result.provider).toBe("motion");
        // A drawtext burn pass ran (the captions were NOT dropped).
        const burned = calls.some((c) => c.cmd === "ffmpeg" && c.argv.some((a) => a.includes("drawtext=")));
        expect(burned).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      _setSubtitlesFilterForTest(undefined);
      _setDrawtextFilterForTest(undefined);
      _setCaptionFontForTest(undefined);
    }
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function spawnCode(cmd: string, argv: string[]): Promise<number> {
  const { spawn } = require("node:child_process");
  return new Promise((res) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    p.on("exit", (c: number | null) => res(c ?? -1));
    p.on("error", () => res(-1));
  });
}

// (keep writeFileSync referenced for future fixture tests)
void writeFileSync;
