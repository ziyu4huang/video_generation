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
  resolveWhisperPython,
  whisperScriptPath,
  clipAdapter,
  esrganAdapter,
  clipScriptPath,
  esrganScriptPath,
  resolveVisionPython,
  _setFfmpegAvailableForTest,
  _setWhisperRuntimeForTest,
  _setVisionRuntimeForTest,
  type WhisperResult,
  type ClipResult,
  type EsrganResult,
} from "./providers.ts";
import { REGISTRY } from "./registry.ts";

beforeAll(() => {
  _setFfmpegAvailableForTest(true);
  _setWhisperRuntimeForTest(true);
  _setVisionRuntimeForTest("clip", true);
  _setVisionRuntimeForTest("esrgan", true);
});
afterAll(() => {
  _setFfmpegAvailableForTest(undefined);
  _setWhisperRuntimeForTest(undefined);
  _setVisionRuntimeForTest("clip", undefined);
  _setVisionRuntimeForTest("esrgan", undefined);
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
    // enhancement capability: esrgan wired (vision/bg_remove was already there).
    const enhancement = m.capabilities.find((c) => c.capability === "enhancement")!;
    expect(enhancement.available_providers).toContain("esrgan");
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

describe("resolveWhisperPython + whisperScriptPath", () => {
  it("resolves the entry script under the ext root", () => {
    expect(whisperScriptPath()).toMatch(/python[\/\\]whisper_transcribe\.py$/);
  });
  it("honors MD_WHISPER_PYTHON when the path exists", () => {
    const fake = process.execPath; // a real binary on disk
    expect(resolveWhisperPython({ MD_WHISPER_PYTHON: fake })).toBe(fake);
  });
  it("falls back when the override does not exist", () => {
    // Walk-up discovery or python3 fallback — either is a non-empty string.
    const got = resolveWhisperPython({ MD_WHISPER_PYTHON: "/no/such/python" });
    expect(typeof got === "string" && got.length > 0).toBe(true);
  });
});

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
      expect(r.error).toContain("whisper runtime not found");
    } finally {
      _setWhisperRuntimeForTest(true);
    }
  });
});

// ─── esrgan adapter (Item I sibling) ──────────────────────────────────────────

const ESRGAN_RESULT: EsrganResult = {
  ok: true,
  image: "/tmp/test.png",
  model: "/repo/mlx-models/upscale/4x-nomos-webphoto-realplksr/4xNomosWebPhoto_RealPLKSR.pth",
  scale: 4,
  in_w: 256,
  in_h: 256,
  out_w: 1024,
  out_h: 1024,
  out: "/tmp/test_4x.png",
  duration_s: 1.4,
};

describe("resolveVisionPython + esrgan/clip script paths", () => {
  it("resolves both entry scripts under the ext root", () => {
    expect(clipScriptPath()).toMatch(/python[\/\\]clip_understand\.py$/);
    expect(esrganScriptPath()).toMatch(/python[\/\\]esrgan_upscale\.py$/);
  });
  it("honors MD_VISION_PYTHON when the path exists", () => {
    const fake = process.execPath;
    expect(resolveVisionPython({ MD_VISION_PYTHON: fake })).toBe(fake);
  });
  it("falls back when the override does not exist", () => {
    const got = resolveVisionPython({ MD_VISION_PYTHON: "/no/such/python" });
    expect(typeof got === "string" && got.length > 0).toBe(true);
  });
});

describe("esrganAdapter (mocked spawn)", () => {
  it("spawns esrgan_upscale.py and returns a well-formed ToolResult", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-esrgan-"));
    try {
      const mockSpawn = async (_cmd: string, argv: string[]): Promise<number> => {
        const outIdx = argv.indexOf("--output");
        if (outIdx >= 0) writeFileSync(argv[outIdx + 1]!, JSON.stringify(ESRGAN_RESULT, null, 2));
        return 0;
      };
      const image = join(dir, "test.png");
      writeFileSync(image, "fake");
      const fakeModel = join(dir, "model.pth");
      writeFileSync(fakeModel, "fake");
      const r = await esrganAdapter({
        capability: "enhancement",
        command: "upscale",
        outputDir: dir,
        options: { image, model: fakeModel, _spawnImpl: mockSpawn },
      });
      expect(r.success).toBe(true);
      expect(r.provider).toBe("esrgan");
      expect(r.command).toBe("upscale");
      expect(r.cost_usd).toBe(0); // local torch MPS — honest $0
      expect(r.artifacts).toHaveLength(1);
      const a = r.artifacts[0]!;
      expect(a.role).toBe("upscaled");
      expect(a.width).toBe(1024);
      expect(a.height).toBe(1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails cleanly when the image is missing", async () => {
    const r = await esrganAdapter({
      capability: "enhancement",
      command: "upscale",
      options: { image: "/no/such.png" },
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("image missing");
  });

  it("fails cleanly when the runtime probe is off", async () => {
    _setVisionRuntimeForTest("esrgan", false);
    try {
      const r = await esrganAdapter({
        capability: "enhancement",
        command: "upscale",
        options: { image: "/tmp/anything" },
      });
      expect(r.success).toBe(false);
      expect(r.error).toContain("esrgan runtime not found");
    } finally {
      _setVisionRuntimeForTest("esrgan", true);
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
  it("spawns clip_understand.py on pre-sampled frames and returns a scored ToolResult", async () => {
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
      expect(r.error).toContain("clip runtime not found");
    } finally {
      _setVisionRuntimeForTest("clip", true);
    }
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function spawnCode(cmd: string, argv: string[]): Promise<number> {
  const { spawn } = require("node:child_process");
  return new Promise((res) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    p.on("exit", (c) => res(c ?? -1));
    p.on("error", () => res(-1));
  });
}

// (keep writeFileSync referenced for future fixture tests)
void writeFileSync;
