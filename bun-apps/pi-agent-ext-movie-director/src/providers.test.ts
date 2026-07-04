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
  _setFfmpegAvailableForTest,
} from "./providers.ts";
import { REGISTRY } from "./registry.ts";

beforeAll(() => _setFfmpegAvailableForTest(true));
afterAll(() => _setFfmpegAvailableForTest(undefined));

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
    // transcriber: explicit GAP:, configured:false.
    const transcriber = REGISTRY.find((p) => p.name === "transcriber")!;
    expect(transcriber.configured).toBe(false);
    expect(probeConfigured(transcriber, NO_ENV)).toBe(false);
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
