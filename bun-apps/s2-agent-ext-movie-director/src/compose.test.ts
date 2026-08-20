import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeVideo, finalReview, _setFfmpegAvailableForTest, _setSubtitlesFilterForTest, _setDrawtextFilterForTest, _setCaptionFontForTest, type EditDecisions } from "./compose.ts";

beforeAll(() => {
  _setFfmpegAvailableForTest(true);
  _setSubtitlesFilterForTest(true);
});
afterAll(() => {
  _setFfmpegAvailableForTest(undefined);
  _setSubtitlesFilterForTest(undefined);
});

// A fake spawn that pretends ffmpeg/ffprobe succeeded and writes the output file
// to disk (composeVideo verifies each segment exists via existsSync).
function fakeSpawn() {
  return async (cmd: string, argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    if (cmd === "ffprobe") {
      return {
        code: 0,
        stdout: JSON.stringify({
          format: { duration: "2.0", format_name: "mov,mp4" },
          streams: [
            { codec_type: "video", codec_name: "h264", width: 320, height: 240, avg_frame_rate: "30/1" },
            { codec_type: "audio", codec_name: "aac" },
          ],
        }),
        stderr: "",
      };
    }
    if (cmd === "ffmpeg") {
      const isVol = argv.includes("-af") && argv.includes("volumedetect");
      if (isVol) return { code: 0, stdout: "", stderr: "mean_volume: -12.0 dB\nmax_volume: -3.0 dB" };
      const fIdx = argv.indexOf("-f");
      const isFrame = fIdx >= 0 && argv[fIdx + 1] === "image2";
      if (isFrame) return { code: 0, stdout: "frame", stderr: "" };
      // real encode: the last arg is the output path — write a placeholder so existsSync passes.
      const out = argv[argv.length - 1];
      if (out && !out.startsWith("-")) writeFileSync(out, "x");
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("composeVideo (mocked ffmpeg)", () => {
  it("returns a render_report when all cuts trim + concat succeed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-comp-"));
    try {
      // Pre-create fake source files so existsSync passes.
      const src1 = join(dir, "a.mp4");
      const src2 = join(dir, "b.mp4");
      writeFileSync(src1, "x");
      writeFileSync(src2, "x");
      const edit: EditDecisions = {
        version: "1.0",
        cuts: [
          { id: "a", source: src1, in_seconds: 0, out_seconds: 1 },
          { id: "b", source: src2, in_seconds: 0, out_seconds: 1 },
        ],
      };
      const out = join(dir, "composed.mp4");
      const report = await composeVideo(edit, { workDir: dir, output: out }, { spawnImpl: fakeSpawn() });
      expect(report.outputs).toHaveLength(1);
      expect(report.outputs[0]!.path).toBe(out);
      expect(report.outputs[0]!.duration_seconds).toBe(2.0);
      expect(report.outputs[0]!.resolution).toBe("320x240");
      expect(report.warnings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops cuts whose source is missing and warns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-comp-miss-"));
    try {
      const src = join(dir, "real.mp4");
      writeFileSync(src, "x");
      const edit: EditDecisions = {
        version: "1.0",
        cuts: [
          { id: "ghost", source: join(dir, "missing.mp4"), in_seconds: 0, out_seconds: 1 },
          { id: "real", source: src, in_seconds: 0, out_seconds: 1 },
        ],
      };
      const report = await composeVideo(edit, { workDir: dir }, { spawnImpl: fakeSpawn() });
      expect(report.warnings.some((w) => w.includes("ghost") && w.includes("missing"))).toBe(true);
      expect(report.outputs).toHaveLength(1); // still composed from the surviving cut
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails cleanly when ffmpeg is absent", async () => {
    _setFfmpegAvailableForTest(false);
    try {
      const edit: EditDecisions = { version: "1.0", cuts: [{ id: "x", source: "/nonexistent", in_seconds: 0, out_seconds: 1 }] };
      const report = await composeVideo(edit, { workDir: "/tmp" });
      expect(report.outputs).toEqual([]);
      expect(report.warnings.some((w) => w.includes("ffmpeg"))).toBe(true);
    } finally {
      _setFfmpegAvailableForTest(true);
    }
  });
});

describe("finalReview (mocked ffmpeg)", () => {
  it("passes all 6 checks on a well-formed mp4", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-fr-"));
    try {
      const mp4 = join(dir, "out.mp4");
      writeFileSync(mp4, "x");
      const review = await finalReview(mp4, { spawnImpl: fakeSpawn() });
      expect(review.verdict).toBe("pass");
      expect(review.checks).toHaveLength(6);
      expect(review.mean_volume_db).toBe(-12.0);
      expect(review.checks.every((c) => c.status === "pass")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when the file is missing", async () => {
    const review = await finalReview("/does/not/exist.mp4");
    expect(review.verdict).toBe("fail");
    expect(review.checks[0]!.status).toBe("fail");
  });

  it("near-silent audio fails the verdict by default (no narration intent declared)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-fr-silent-"));
    try {
      const mp4 = join(dir, "out.mp4");
      writeFileSync(mp4, "x");
      const silentSpawn: typeof fakeSpawn = () => async (cmd, argv) => {
        if (cmd === "ffmpeg" && argv.includes("-af") && argv.includes("volumedetect")) {
          return { code: 0, stdout: "", stderr: "mean_volume: -60.0 dB\nmax_volume: -55.0 dB" };
        }
        return fakeSpawn()(cmd, argv);
      };
      const review = await finalReview(mp4, { spawnImpl: silentSpawn() });
      expect(review.verdict).toBe("fail");
      const audioCheck = review.checks.find((c) => c.name === "audio_level")!;
      expect(audioCheck.status).toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("near-silent audio does NOT fail when narration:'none' declares it intentional (ambient-only)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-fr-ambient-"));
    try {
      const mp4 = join(dir, "out.mp4");
      writeFileSync(mp4, "x");
      const silentSpawn: typeof fakeSpawn = () => async (cmd, argv) => {
        if (cmd === "ffmpeg" && argv.includes("-af") && argv.includes("volumedetect")) {
          return { code: 0, stdout: "", stderr: "mean_volume: -60.0 dB\nmax_volume: -55.0 dB" };
        }
        return fakeSpawn()(cmd, argv);
      };
      const review = await finalReview(mp4, { spawnImpl: silentSpawn() }, { narration: "none" });
      const audioCheck = review.checks.find((c) => c.name === "audio_level")!;
      expect(audioCheck.status).toBe("warn");
      expect(review.verdict).toBe("pass"); // no fail-status checks → verdict pass
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends an advisory transcript check when transcriptPath is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-fr-tx-"));
    try {
      const mp4 = join(dir, "out.mp4");
      const tx = join(dir, "transcript.txt");
      writeFileSync(mp4, "x");
      writeFileSync(tx, "Welcome to the movie director pipeline.\n");
      const review = await finalReview(mp4, { spawnImpl: fakeSpawn() }, { transcriptPath: tx });
      // advisory check appended but verdict stays pass (non-blocking).
      expect(review.verdict).toBe("pass");
      const txCheck = review.checks.find((c) => c.name === "transcript")!;
      expect(txCheck).toBeDefined();
      expect(txCheck.status === "pass" || txCheck.status === "warn").toBe(true);
      expect(txCheck.detail).toContain("6 words");
      expect(review.transcript).toContain("Welcome to the movie director pipeline");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("composeVideo captions (Item I)", () => {
  it("hard-burns captions when the libass subtitles filter is available", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-cap-burn-"));
    try {
      const src = join(dir, "src.mp4");
      const srt = join(dir, "captions.srt");
      writeFileSync(src, "x");
      writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\nhi\n");
      _setSubtitlesFilterForTest(true);
      const report = await composeVideo(
        { version: "1.0", cuts: [{ id: "a", source: src, in_seconds: 0, out_seconds: 1 }] },
        { workDir: dir, output: join(dir, "out.mp4"), captions: { srtPath: srt, burn: true } },
        { spawnImpl: fakeSpawn() },
      );
      expect(report.outputs).toHaveLength(1);
      expect(report.verification_notes.some((n) => n.includes("burned"))).toBe(true);
      expect(report.warnings.some((w) => w.includes("libass"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to mov_text sidecar when libass AND drawtext are unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-cap-side-"));
    try {
      const src = join(dir, "src.mp4");
      const srt = join(dir, "captions.srt");
      writeFileSync(src, "x");
      writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\nhi\n");
      _setSubtitlesFilterForTest(false);
      _setDrawtextFilterForTest(false);
      const report = await composeVideo(
        { version: "1.0", cuts: [{ id: "a", source: src, in_seconds: 0, out_seconds: 1 }] },
        { workDir: dir, output: join(dir, "out.mp4"), captions: { srtPath: srt, burn: true } },
        { spawnImpl: fakeSpawn() },
      );
      expect(report.verification_notes.some((n) => n.includes("sidecar"))).toBe(true);
      expect(report.warnings.some((w) => w.includes("libass") && w.includes("drawtext") && w.includes("sidecar"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      _setSubtitlesFilterForTest(true);
      _setDrawtextFilterForTest(undefined);
    }
  });

  it("hard-burns via drawtext when libass is absent but drawtext+font resolve", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-cap-dt-"));
    try {
      const src = join(dir, "src.mp4");
      const srt = join(dir, "captions.srt");
      writeFileSync(src, "x");
      // Two cues to exercise the multi-node drawtext chain + text escaping.
      writeFileSync(srt, [
        "1", "00:00:00,500 --> 00:00:01,500", "Hello: world!", "",
        "2", "00:00:02,000 --> 00:00:03,000", "It's 100% done", "",
      ].join("\n"));
      _setSubtitlesFilterForTest(false);
      _setDrawtextFilterForTest(true);
      _setCaptionFontForTest("/System/Library/Fonts/Supplemental/Arial.ttf");
      const calls: string[][] = [];
      const spawn = fakeSpawn();
      const report = await composeVideo(
        { version: "1.0", cuts: [{ id: "a", source: src, in_seconds: 0, out_seconds: 1 }] },
        { workDir: dir, output: join(dir, "out.mp4"), captions: { srtPath: srt, burn: true } },
        { spawnImpl: async (cmd, argv) => { calls.push(argv); return spawn(cmd, argv); } },
      );
      // The burn pass ran and reported the drawtext tier.
      expect(report.verification_notes.some((n) => n.includes("burned (drawtext)"))).toBe(true);
      expect(report.warnings.some((w) => w.includes("libass"))).toBe(false);
      // The captions argv contains a drawtext node with enable='between(...)' per cue.
      const capArgv = calls.find((a) => a.includes("-vf") && a.some((x) => x.startsWith("drawtext")));
      expect(capArgv).toBeDefined();
      const vf = capArgv![capArgv!.indexOf("-vf") + 1]!;
      // Two cues → two drawtext nodes, each timeline-gated.
      expect(vf.match(/drawtext=/g)?.length).toBe(2);
      expect(vf).toContain("enable='between(t,0.500,1.500)'");
      expect(vf).toContain("enable='between(t,2.000,3.000)'");
      // Special chars escaped (colon, apostrophe, percent).
      expect(vf).toContain("Hello\\: world!");
      expect(vf).toContain("It\\'s 100\\% done");
      // Fontfile resolved + bottom-center positioning.
      expect(vf).toContain("fontfile='/System/Library/Fonts/Supplemental/Arial.ttf'");
      expect(vf).toContain("y=h-text_h-72");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      _setSubtitlesFilterForTest(true);
      _setDrawtextFilterForTest(undefined);
      _setCaptionFontForTest(undefined);
    }
  });

  it("falls to sidecar when drawtext is present but no font resolves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-cap-nofont-"));
    try {
      const src = join(dir, "src.mp4");
      const srt = join(dir, "captions.srt");
      writeFileSync(src, "x");
      writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\nhi\n");
      _setSubtitlesFilterForTest(false);
      _setDrawtextFilterForTest(true);
      _setCaptionFontForTest(null);
      const report = await composeVideo(
        { version: "1.0", cuts: [{ id: "a", source: src, in_seconds: 0, out_seconds: 1 }] },
        { workDir: dir, output: join(dir, "out.mp4"), captions: { srtPath: srt, burn: true } },
        { spawnImpl: fakeSpawn() },
      );
      expect(report.verification_notes.some((n) => n.includes("sidecar"))).toBe(true);
      expect(report.warnings.some((w) => w.includes("drawtext") && w.includes("font") && w.includes("sidecar"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      _setSubtitlesFilterForTest(true);
      _setDrawtextFilterForTest(undefined);
      _setCaptionFontForTest(undefined);
    }
  });

  it("warns when the captions srt does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-cap-miss-"));
    try {
      const src = join(dir, "src.mp4");
      writeFileSync(src, "x");
      const report = await composeVideo(
        { version: "1.0", cuts: [{ id: "a", source: src, in_seconds: 0, out_seconds: 1 }] },
        { workDir: dir, output: join(dir, "out.mp4"), captions: { srtPath: join(dir, "no.srt") } },
        { spawnImpl: fakeSpawn() },
      );
      expect(report.warnings.some((w) => w.includes("captions srt not found"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("compose + final-review end-to-end (real ffmpeg)", () => {
  it("composes two lavfi clips into a real mp4 that passes final_review", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-e2e-"));
    try {
      const { spawn } = require("node:child_process");
      const run = (cmd: string, argv: string[]) =>
        new Promise<number>((res) => {
          const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
          p.on("exit", (c: number | null) => res(c ?? -1));
          p.on("error", () => res(-1));
        });
      const a = join(dir, "a.mp4");
      const b = join(dir, "b.mp4");
      const ga = await run("ffmpeg", ["-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=15",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", "-y", a]);
      const gb = await run("ffmpeg", ["-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=15",
        "-f", "lavfi", "-i", "sine=frequency=660:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", "-y", b]);
      if (ga !== 0 || gb !== 0 || !existsSync(a) || !existsSync(b)) {
        console.warn("real-ffmpeg smoke: source gen failed, skipping");
        return;
      }
      const out = join(dir, "composed.mp4");
      const report = await composeVideo(
        { version: "1.0", cuts: [{ id: "a", source: a, in_seconds: 0, out_seconds: 1 }, { id: "b", source: b, in_seconds: 0, out_seconds: 1 }] },
        { workDir: dir, output: out },
      );
      expect(report.outputs).toHaveLength(1);
      expect(existsSync(report.outputs[0]!.path)).toBe(true);
      expect(report.outputs[0]!.duration_seconds).toBeGreaterThan(0);
      // final_review on the composed file.
      const review = await finalReview(report.outputs[0]!.path);
      expect(review.verdict).toBe("pass");
      expect(review.checks).toHaveLength(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
