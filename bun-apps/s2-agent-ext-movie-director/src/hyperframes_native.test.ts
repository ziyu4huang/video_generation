import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderHyperframes,
  resolveHyperframesBin,
  _resetHyperframesBinCacheForTest,
  buildHyperframesComposition,
  type RemotionEditDecisions,
  type SpawnImpl,
  type SpawnResult,
} from "./hyperframes_native.ts";

// Drive binary resolution deterministically: point HYPERFRAMES_BIN at a real
// file (this test file itself) so resolveHyperframesBin returns it verbatim —
// no PATH probing, no bunx. fakeSpawn then matches by argv pattern.
const FAKE_BIN = import.meta.path;

beforeEach(() => {
  process.env.HYPERFRAMES_BIN = FAKE_BIN;
  _resetHyperframesBinCacheForTest();
});
afterEach(() => {
  delete process.env.HYPERFRAMES_BIN;
  _resetHyperframesBinCacheForTest();
});

function fakeSpawn(behavior: { renderExit?: number } = {}): SpawnImpl {
  return async (cmd: string, argv: string[]): Promise<SpawnResult> => {
    if (argv.includes("--version")) return { code: 0, stdout: "hyperframes 0.7.100", stderr: "" };
    if (argv.includes("render")) {
      const outIdx = argv.indexOf("-o");
      const out = outIdx >= 0 ? argv[outIdx + 1] : undefined;
      if (behavior.renderExit !== 0 && behavior.renderExit !== undefined) {
        return { code: behavior.renderExit, stdout: "", stderr: "render boom" };
      }
      if (out) writeFileSync(out, "x"); // placeholder so existsSync passes
      return { code: 0, stdout: "rendered", stderr: "" };
    }
    if (cmd === "ffprobe") {
      return {
        code: 0,
        stdout: JSON.stringify({
          format: { duration: "3.0", format_name: "mov,mp4" },
          streams: [
            { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1" },
            { codec_type: "audio", codec_name: "aac" },
          ],
        }),
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("resolveHyperframesBin", () => {
  it("uses HYPERFRAMES_BIN verbatim when the file exists", async () => {
    const bin = await resolveHyperframesBin();
    expect(bin).not.toBeNull();
    expect(bin!.cmd).toBe(FAKE_BIN);
    expect(bin!.pre).toEqual([]);
  });

  it("returns null when HYPERFRAMES_BIN is set but missing", async () => {
    process.env.HYPERFRAMES_BIN = "/does/not/exist/hyperframes";
    _resetHyperframesBinCacheForTest();
    const bin = await resolveHyperframesBin();
    expect(bin).toBeNull();
  });

  it("falls back to bunx when PATH probing fails", async () => {
    delete process.env.HYPERFRAMES_BIN;
    _resetHyperframesBinCacheForTest();
    const failing: SpawnImpl = async (_cmd, argv) =>
      argv.includes("--version") ? { code: 1, stdout: "", stderr: "not on PATH" } : { code: 0, stdout: "", stderr: "" };
    const bin = await resolveHyperframesBin(failing);
    expect(bin).not.toBeNull();
    expect(bin!.cmd).toBe("bunx");
    expect(bin!.pre).toEqual(["hyperframes"]);
  });
});

describe("buildHyperframesComposition — pure HTML generator", () => {
  it("emits a sized root with data-start=0 and max(out_seconds) duration", () => {
    const edit: RemotionEditDecisions = {
      version: "1.0",
      cuts: [{ id: "a", type: "text", text: "Hello", in_seconds: 0, out_seconds: 4 }],
    };
    const built = buildHyperframesComposition(edit, { width: 1920, height: 1080 });
    expect(built.durationSeconds).toBe(4);
    expect(built.html).toContain('data-composition-id="edit"');
    expect(built.html).toContain('data-start="0"');
    expect(built.html).toContain('data-duration="4"');
    expect(built.html).toContain('data-width="1920"');
    expect(built.html).toContain('data-height="1080"');
    expect(built.html).toContain("Hello");
  });

  it("registers exactly one paused GSAP timeline keyed to the root id", () => {
    const edit: RemotionEditDecisions = {
      version: "1.0",
      cuts: [{ id: "a", type: "text", text: "Hi", in_seconds: 0, out_seconds: 2 }],
    };
    const built = buildHyperframesComposition(edit, { width: 1920, height: 1080 });
    expect(built.html.match(/gsap\.timeline\(/g)).toHaveLength(1);
    expect(built.html).toContain('gsap.timeline({ paused: true })');
    expect(built.html).toContain('window.__timelines["edit"] = tl;');
  });

  it("drops missing media sources with a warning, keeps text/valid cuts", () => {
    const edit: RemotionEditDecisions = {
      version: "1.0",
      cuts: [
        { id: "ghost", source: "/does/not/exist.png", in_seconds: 0, out_seconds: 1 },
        { id: "t", type: "text", text: "Hi", in_seconds: 1, out_seconds: 2 },
      ],
    };
    const built = buildHyperframesComposition(edit, { width: 1920, height: 1080 });
    expect(built.warnings.some((w) => w.includes("ghost") && w.includes("missing"))).toBe(true);
    expect(built.html).toContain("Hi");
    expect(built.html).not.toContain("does/not/exist.png");
  });

  it("returns empty html when every cut is dropped", () => {
    const edit: RemotionEditDecisions = { version: "1.0", cuts: [{ id: "ghost", source: "/nope.png", in_seconds: 0, out_seconds: 1 }] };
    const built = buildHyperframesComposition(edit, { width: 1920, height: 1080 });
    expect(built.html).toBe("");
    expect(built.durationSeconds).toBe(0);
  });

  it("crossfade fades non-edge cuts but skips the head/tail edge", () => {
    const edit: RemotionEditDecisions = {
      version: "1.0",
      cuts: [
        { id: "a", type: "text", text: "A", in_seconds: 0, out_seconds: 2 },
        { id: "b", type: "text", text: "B", in_seconds: 2, out_seconds: 4 },
      ],
      transition: "crossfade",
      transitionSeconds: 0.5,
    };
    const built = buildHyperframesComposition(edit, { width: 1920, height: 1080 });
    // "a" is the head: no fade-in tween targeting its own -inner opacity 0->1 at time 0.
    expect(built.html).not.toMatch(/fromTo\("#cut-a-inner", \{ opacity: 0 \}/);
    // "a" fades OUT into "b" (not the tail).
    expect(built.html).toMatch(/fromTo\("#cut-a-inner", \{ opacity: 1 \}, \{ opacity: 0/);
    // "b" is the tail: fades IN from "a", but has no fade-out tween.
    expect(built.html).toMatch(/fromTo\("#cut-b-inner", \{ opacity: 0 \}/);
    expect(built.html).not.toMatch(/fromTo\("#cut-b-inner", \{ opacity: 1 \}, \{ opacity: 0/);
  });

  it("transition:none applies no boundary fades", () => {
    const edit: RemotionEditDecisions = {
      version: "1.0",
      cuts: [
        { id: "a", type: "text", text: "A", in_seconds: 0, out_seconds: 2 },
        { id: "b", type: "text", text: "B", in_seconds: 2, out_seconds: 4 },
      ],
      transition: "none",
    };
    const built = buildHyperframesComposition(edit, { width: 1920, height: 1080 });
    expect(built.html.match(/-inner"\s*,\s*\{\s*opacity/g)).toBeNull();
  });

  it("escapes text content and sanitizes ids", () => {
    const edit: RemotionEditDecisions = {
      version: "1.0",
      cuts: [{ id: "weird id!!", type: "text", text: "<script>alert(1)</script>", in_seconds: 0, out_seconds: 1 }],
    };
    const built = buildHyperframesComposition(edit, { width: 1920, height: 1080 });
    expect(built.html).not.toContain("<script>alert(1)</script>");
    expect(built.html).toContain("&lt;script&gt;");
    expect(built.html).toContain('id="cut-weird-id--"');
  });

  it("places overlays on data-track-index=1, cuts on 0", () => {
    const edit: RemotionEditDecisions = {
      version: "1.0",
      cuts: [{ id: "a", type: "text", text: "A", in_seconds: 0, out_seconds: 3 }],
      overlays: [{ type: "section_title", in_seconds: 0, out_seconds: 2, text: "Title" }],
    };
    const built = buildHyperframesComposition(edit, { width: 1920, height: 1080 });
    expect(built.html).toMatch(/id="cut-a"[^>]*data-track-index="0"/);
    expect(built.html).toMatch(/id="overlay-0"[^>]*data-track-index="1"/);
    expect(built.durationSeconds).toBe(3); // max(cut.out=3, overlay.out=2)
  });

  it("emits a narration <audio> element on data-track-index=2 with default volume 1", () => {
    const edit: RemotionEditDecisions = {
      version: "1.0",
      cuts: [{ id: "a", type: "text", text: "A", in_seconds: 0, out_seconds: 3 }],
      audio: { narration: { src: "https://example.com/narration.mp3" } },
    };
    const built = buildHyperframesComposition(edit, { width: 1920, height: 1080 });
    expect(built.html).toMatch(/<audio id="narration" src="https:\/\/example\.com\/narration\.mp3" data-start="0" data-track-index="2" data-volume="1">/);
    expect(built.warnings).toEqual([]);
  });

  it("emits narration with a custom volume and no data-duration", () => {
    const edit: RemotionEditDecisions = {
      version: "1.0",
      cuts: [{ id: "a", type: "text", text: "A", in_seconds: 0, out_seconds: 3 }],
      audio: { narration: { src: "https://example.com/narration.mp3", volume: 0.8 } },
    };
    const built = buildHyperframesComposition(edit, { width: 1920, height: 1080 });
    expect(built.html).toContain('data-volume="0.8"');
    expect(built.html).not.toMatch(/<audio[^>]*data-duration/);
  });

  it("warns and omits the audio element when narration source is missing", () => {
    const edit: RemotionEditDecisions = {
      version: "1.0",
      cuts: [{ id: "a", type: "text", text: "A", in_seconds: 0, out_seconds: 3 }],
      audio: { narration: { src: "/does/not/exist.mp3" } },
    };
    const built = buildHyperframesComposition(edit, { width: 1920, height: 1080 });
    expect(built.warnings.some((w) => w.includes("narration source missing"))).toBe(true);
    expect(built.html).not.toContain("<audio");
  });
});

describe("renderHyperframes (mocked binary)", () => {
  it("writes the composition HTML, renders, and assembles a render_report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-hf-"));
    try {
      const src = join(dir, "a.png");
      writeFileSync(src, "x");
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [{ id: "a", source: src, in_seconds: 0, out_seconds: 3, animation: "ken-burns" }],
        overlays: [{ type: "section_title", in_seconds: 0, out_seconds: 2, text: "Hello" }],
        transition: "crossfade",
        theme: "dark",
      };
      const out = join(dir, "out.mp4");
      const report = await renderHyperframes(edit, { workDir: dir, output: out }, { spawnImpl: fakeSpawn() });
      expect(report.outputs).toHaveLength(1);
      expect(report.outputs[0]!.path).toBe(out);
      expect(report.outputs[0]!.duration_seconds).toBe(3.0);
      expect(report.outputs[0]!.resolution).toBe("1920x1080");
      expect(report.warnings).toEqual([]);
      expect(report.render_grammar).toBe("hyperframes");

      const html = readFileSync(join(dir, "hyperframes-composition.html"), "utf8");
      expect(html).toContain("Hello");
      expect(html).toContain('data-duration="3"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops missing sources with a warning but renders the survivors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-hf-miss-"));
    try {
      const real = join(dir, "real.png");
      writeFileSync(real, "x");
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [
          { id: "ghost", source: join(dir, "ghost.png"), in_seconds: 0, out_seconds: 1, animation: "zoom-in" },
          { id: "real", source: real, in_seconds: 0, out_seconds: 1, animation: "zoom-in" },
        ],
      };
      const report = await renderHyperframes(edit, { workDir: dir }, { spawnImpl: fakeSpawn() });
      expect(report.outputs).toHaveLength(1);
      expect(report.warnings.some((w) => w.includes("ghost") && w.includes("missing"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails cleanly when the binary is unresolvable", async () => {
    process.env.HYPERFRAMES_BIN = "/nope/hyperframes";
    _resetHyperframesBinCacheForTest();
    const dir = mkdtempSync(join(tmpdir(), "md-hf-nobin-"));
    try {
      const edit: RemotionEditDecisions = { version: "1.0", cuts: [{ id: "a", source: join(dir, "a.png"), in_seconds: 0, out_seconds: 1 }] };
      const report = await renderHyperframes(edit, { workDir: dir }, { spawnImpl: fakeSpawn() });
      expect(report.outputs).toEqual([]);
      expect(report.warnings.some((w) => w.includes("hyperframes binary not found"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a render failure with the stderr tail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-hf-fail-"));
    try {
      const src = join(dir, "a.png");
      writeFileSync(src, "x");
      const edit: RemotionEditDecisions = { version: "1.0", cuts: [{ id: "a", source: src, in_seconds: 0, out_seconds: 1 }] };
      const report = await renderHyperframes(edit, { workDir: dir, output: join(dir, "out.mp4") }, { spawnImpl: fakeSpawn({ renderExit: 7 }) });
      expect(report.outputs).toEqual([]);
      expect(report.warnings.some((w) => w.includes("exit 7"))).toBe(true);
      expect(report.verification_notes.some((n) => n.includes("render boom"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips with an empty report when there are no cuts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-hf-empty-"));
    try {
      const report = await renderHyperframes({ version: "1.0", cuts: [] }, { workDir: dir }, { spawnImpl: fakeSpawn() });
      expect(report.outputs).toEqual([]);
      expect(report.warnings.some((w) => w.includes("no cuts"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("text cuts need no source file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-hf-text-"));
    try {
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [{ id: "t", type: "text", text: "Hi", in_seconds: 0, out_seconds: 2 }],
      };
      const report = await renderHyperframes(edit, { workDir: dir, output: join(dir, "out.mp4") }, { spawnImpl: fakeSpawn() });
      expect(report.outputs).toHaveLength(1);
      expect(existsSync(report.outputs[0]!.path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns (without failing) when edit.audio.music is present — v1 does not wire music", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-hf-music-"));
    try {
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [{ id: "t", type: "text", text: "Hi", in_seconds: 0, out_seconds: 2 }],
        audio: { music: { src: "/some/music.mp3" } },
      };
      const report = await renderHyperframes(edit, { workDir: dir, output: join(dir, "out.mp4") }, { spawnImpl: fakeSpawn() });
      expect(report.outputs).toHaveLength(1);
      expect(report.warnings.some((w) => w.includes("does not support edit.audio.music"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stages and wires narration audio with no warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-hf-narration-"));
    try {
      const narrationSrc = join(dir, "narration.mp3");
      writeFileSync(narrationSrc, "x");
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [{ id: "t", type: "text", text: "Hi", in_seconds: 0, out_seconds: 2 }],
        audio: { narration: { src: narrationSrc, volume: 0.9 } },
      };
      const report = await renderHyperframes(edit, { workDir: dir, output: join(dir, "out.mp4") }, { spawnImpl: fakeSpawn() });
      expect(report.outputs).toHaveLength(1);
      expect(report.warnings).toEqual([]);

      const html = readFileSync(join(dir, "hyperframes-composition.html"), "utf8");
      expect(html).toContain('data-volume="0.9"');
      expect(html).toContain("hyperframes-assets/narration__narration.mp3");
      expect(existsSync(join(dir, "hyperframes-assets", "narration__narration.mp3"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns but still renders when narration source is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-hf-narration-miss-"));
    try {
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [{ id: "t", type: "text", text: "Hi", in_seconds: 0, out_seconds: 2 }],
        audio: { narration: { src: join(dir, "ghost-narration.mp3") } },
      };
      const report = await renderHyperframes(edit, { workDir: dir, output: join(dir, "out.mp4") }, { spawnImpl: fakeSpawn() });
      expect(report.outputs).toHaveLength(1);
      expect(report.warnings.some((w) => w.includes("narration source missing"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
