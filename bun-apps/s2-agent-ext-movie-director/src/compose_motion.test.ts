import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeMotion, type SpawnImpl, type SpawnResult, type MotionDeps } from "./compose_motion.ts";
import type { RemotionEditDecisions } from "./remotion.ts";

/**
 * Drive the motion compositor with a mocked ffmpeg. The fake matches calls by
 * argv pattern: per-cut motion renders + the final join (concat or xfade) write
 * a placeholder at the LAST argv path; ffprobe calls return a fixed JSON. This
 * verifies argv shape + report assembly WITHOUT a real ffmpeg render (the
 * real-silicon smoke is the e2e script scripts/run-compose-motion-e2e.ts).
 */
function fakeSpawn(behavior: { motionExit?: number; joinExit?: number } = {}): SpawnImpl {
  const calls: { cmd: string; argv: string[] }[] = [];
  const impl: SpawnImpl = async (cmd: string, argv: string[]): Promise<SpawnResult> => {
    calls.push({ cmd, argv });
    if (cmd === "ffprobe") {
      // duration probe: return a plain number (default=nw=1:nk=1) OR json.
      if (argv.includes("-show_streams")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            format: { duration: "2.0", format_name: "mov,mp4" },
            streams: [
              { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1" },
              { codec_type: "audio", codec_name: "aac" },
            ],
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "2.0\n", stderr: "" }; // segment duration probe
    }
    // ffmpeg per-cut motion render: last arg is the segment path.
    if (argv.includes("-vf")) {
      if (behavior.motionExit != null) return { code: behavior.motionExit, stdout: "", stderr: "motion boom" };
      const out = argv[argv.length - 1];
      if (out) writeFileSync(out, "x");
      return { code: 0, stdout: "", stderr: "" };
    }
    // ffmpeg final join (concat or xfade): last arg is the output path.
    if (argv.includes("-filter_complex")) {
      if (behavior.joinExit != null) return { code: behavior.joinExit, stdout: "", stderr: "join boom" };
      const out = argv[argv.length - 1];
      if (out) writeFileSync(out, "x");
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  // Attach calls for inspection (TS: cast to a bag).
  (impl as unknown as { _calls: { cmd: string; argv: string[] }[] })._calls = calls;
  return impl;
}

function callsOf(impl: SpawnImpl): { cmd: string; argv: string[] }[] {
  return (impl as unknown as { _calls: { cmd: string; argv: string[] }[] })._calls;
}

describe("composeMotion (mocked ffmpeg)", () => {
  it("bakes a zoompan filter for animated cuts and joins via xfade crossfade", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-motion-"));
    try {
      const a = join(dir, "a.png");
      const b = join(dir, "b.png");
      writeFileSync(a, "x");
      writeFileSync(b, "x");
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [
          { id: "a", source: a, in_seconds: 0, out_seconds: 2, animation: "ken-burns" },
          { id: "b", source: b, in_seconds: 0, out_seconds: 2, animation: "zoom-in" },
        ],
        transition: "crossfade",
        transitionSeconds: 0.5,
      };
      const out = join(dir, "out.mp4");
      const deps: MotionDeps = { spawnImpl: fakeSpawn() };
      const report = await composeMotion(edit, { workDir: dir, output: out, width: 320, height: 180, fps: 10 }, deps);

      expect(report.outputs).toHaveLength(1);
      expect(report.outputs[0]!.path).toBe(out);
      expect(report.outputs[0]!.duration_seconds).toBe(2.0);
      expect(report.outputs[0]!.resolution).toBe("1920x1080"); // from the mocked ffprobe
      expect(report.outputs[0]!.codec).toBe("h264");
      expect(report.render_grammar).toBe("motion");
      expect(report.warnings).toEqual([]);

      const calls = callsOf(deps.spawnImpl!);
      // Per-cut motion renders carry zoompan (animated cuts).
      const motionVf = calls
        .filter((c) => c.cmd === "ffmpeg" && c.argv.includes("-vf"))
        .map((c) => c.argv[c.argv.indexOf("-vf") + 1]);
      expect(motionVf).toHaveLength(2);
      expect(motionVf.every((vf) => vf?.includes("zoompan"))).toBe(true);
      // The final join uses xfade (crossfade + 2 segments).
      const joinCall = calls.find((c) => c.cmd === "ffmpeg" && c.argv.includes("-filter_complex"));
      expect(joinCall).toBeDefined();
      expect(joinCall!.argv[joinCall!.argv.indexOf("-filter_complex") + 1]).toContain("xfade");
      // Verification note records the crossfade.
      expect(report.verification_notes.some((n) => n.includes("crossfade"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loops still-image inputs (-loop 1) and seeks video inputs (-ss)", async () => {
    // A still image is a single frame; without -loop 1 zoompan exhausts it after
    // one frame and the segment renders as ~1 frame (xfade offset math then sees
    // a near-zero duration and the join fails). Video inputs keep seek-then-trim.
    const dir = mkdtempSync(join(tmpdir(), "md-motion-loop-"));
    try {
      const img = join(dir, "scene.png");
      const vid = join(dir, "clip.mp4");
      writeFileSync(img, "x");
      writeFileSync(vid, "x");
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [
          { id: "img", source: img, in_seconds: 0, out_seconds: 2, animation: "ken-burns" },
          { id: "vid", source: vid, in_seconds: 1, out_seconds: 3, animation: "zoom-in" },
        ],
        transition: "none",
      };
      const out = join(dir, "out.mp4");
      const deps: MotionDeps = { spawnImpl: fakeSpawn() };
      const report = await composeMotion(edit, { workDir: dir, output: out, width: 160, height: 90, fps: 5 }, deps);
      expect(report.outputs).toHaveLength(1);
      const calls = callsOf(deps.spawnImpl!).filter((c) => c.cmd === "ffmpeg" && c.argv.includes("-vf"));
      // Two per-cut renders.
      expect(calls).toHaveLength(2);
      const imgArgv = calls.find((c) => c.argv.includes(img))!.argv;
      const vidArgv = calls.find((c) => c.argv.includes(vid))!.argv;
      // Image: -loop 1 present, no -ss.
      expect(imgArgv).toContain("-loop");
      expect(imgArgv).toContain("1");
      expect(imgArgv).not.toContain("-ss");
      // Video: -ss present (seek to in_seconds=1), no -loop.
      expect(vidArgv).toContain("-ss");
      expect(vidArgv[vidArgv.indexOf("-ss") + 1]).toBe("1");
      expect(vidArgv).not.toContain("-loop");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns when a video-source cut's in_seconds is at/past the source's probed duration", async () => {
    // fakeSpawn's ffprobe duration probe always returns 2.0. A cut with
    // in_seconds=2 (>= probed duration) reproduces the exact silent-collapse
    // bug this defensive check exists to catch: ffmpeg -ss past EOF trims to
    // ~0s with no error, so the warning is the only signal a caller gets.
    const dir = mkdtempSync(join(tmpdir(), "md-motion-collapse-"));
    try {
      const vid = join(dir, "clip.mp4");
      writeFileSync(vid, "x");
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [{ id: "vid", source: vid, in_seconds: 2, out_seconds: 4, animation: "zoom-in" }],
        transition: "none",
      };
      const out = join(dir, "out.mp4");
      const report = await composeMotion(edit, { workDir: dir, output: out }, { spawnImpl: fakeSpawn() });
      expect(report.outputs).toHaveLength(1);
      expect(report.warnings.some((w) => w.includes('"vid"') && w.includes("probed duration"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not warn when a video-source cut's in_seconds is well within the source's duration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-motion-nocollapse-"));
    try {
      const vid = join(dir, "clip.mp4");
      writeFileSync(vid, "x");
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [{ id: "vid", source: vid, in_seconds: 0, out_seconds: 1, animation: "zoom-in" }],
        transition: "none",
      };
      const out = join(dir, "out.mp4");
      const report = await composeMotion(edit, { workDir: dir, output: out }, { spawnImpl: fakeSpawn() });
      expect(report.outputs).toHaveLength(1);
      expect(report.warnings.some((w) => w.includes("probed duration"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("static cut omits zoompan; transition=none joins via plain concat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-motion-static-"));
    try {
      const a = join(dir, "a.png");
      writeFileSync(a, "x");
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [{ id: "a", source: a, in_seconds: 0, out_seconds: 1, animation: "static" }],
        transition: "none",
      };
      const out = join(dir, "out.mp4");
      const deps: MotionDeps = { spawnImpl: fakeSpawn() };
      const report = await composeMotion(edit, { workDir: dir, output: out, width: 160, height: 90, fps: 5 }, deps);
      expect(report.outputs).toHaveLength(1);
      const calls = callsOf(deps.spawnImpl!);
      const motionVf = calls
        .filter((c) => c.cmd === "ffmpeg" && c.argv.includes("-vf"))
        .map((c) => c.argv[c.argv.indexOf("-vf") + 1]);
      expect(motionVf).toHaveLength(1);
      expect(motionVf[0]!.includes("zoompan")).toBe(false); // static → no motion filter
      // Single segment, transition=none → concat (no xfade).
      const joinCall = calls.find((c) => c.cmd === "ffmpeg" && c.argv.includes("-filter_complex"));
      expect(joinCall!.argv[joinCall!.argv.indexOf("-filter_complex") + 1]).toContain("concat");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops text cuts and missing sources with warnings when drawtext is absent (never crashes)", async () => {
    const { _setDrawtextFilterForTest, _setCaptionFontForTest } = await import("./captions.ts");
    _setDrawtextFilterForTest(false);
    _setCaptionFontForTest(null);
    try {
      const dir = mkdtempSync(join(tmpdir(), "md-motion-drop-"));
      try {
        const a = join(dir, "a.png");
        writeFileSync(a, "x");
        const edit: RemotionEditDecisions = {
          version: "1.0",
          cuts: [
            { id: "a", source: a, in_seconds: 0, out_seconds: 1, animation: "zoom-in" },
            { id: "text1", type: "text", text: "hello", in_seconds: 0, out_seconds: 1 },
            { id: "gone", source: "/no/such.png", in_seconds: 0, out_seconds: 1 },
          ],
          transition: "none",
        };
        const out = join(dir, "out.mp4");
        const report = await composeMotion(edit, { workDir: dir, output: out }, { spawnImpl: fakeSpawn() });
        expect(report.outputs).toHaveLength(1);
        expect(report.warnings.some((w) => w.includes("text cut") && w.includes("drawtext"))).toBe(true);
        expect(report.warnings.some((w) => w.includes('"gone" source missing'))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      _setDrawtextFilterForTest(undefined);
      _setCaptionFontForTest(undefined);
    }
  });

  it("renders text cuts as color+drawtext segments when drawtext resolves", async () => {
    const { _setDrawtextFilterForTest, _setCaptionFontForTest } = await import("./captions.ts");
    _setDrawtextFilterForTest(true);
    _setCaptionFontForTest("/System/Library/Fonts/Supplemental/Arial.ttf");
    try {
      const dir = mkdtempSync(join(tmpdir(), "md-motion-text-"));
      try {
        const edit: RemotionEditDecisions = {
          version: "1.0",
          cuts: [
            { id: "title", type: "text", text: "Chapter One", backgroundColor: "#1a1a2e", in_seconds: 0, out_seconds: 2 },
          ],
          transition: "none",
        };
        const out = join(dir, "out.mp4");
        const deps: MotionDeps = { spawnImpl: fakeSpawn() };
        const report = await composeMotion(edit, { workDir: dir, output: out, width: 1280, height: 720 }, deps);
        expect(report.outputs).toHaveLength(1);
        expect(report.verification_notes.some((n) => n.includes("text card") && n.includes("Chapter One"))).toBe(true);
        // The text-card render call is a color lavfi source + a drawtext -vf.
        const calls = callsOf(deps.spawnImpl!);
        const textArgv = calls.find((c) => c.argv.some((x) => typeof x === "string" && x.startsWith("color=c=")))?.argv;
        expect(textArgv).toBeDefined();
        expect(textArgv!.some((x) => typeof x === "string" && x.startsWith("drawtext=") && x.includes("Chapter One"))).toBe(true);
        // The hex background normalized to ffmpeg's 0xRRGGBB form.
        expect(textArgv!.some((x) => typeof x === "string" && x.includes("color=c=0x1a1a2e"))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      _setDrawtextFilterForTest(undefined);
      _setCaptionFontForTest(undefined);
    }
  });

  it("empty cuts → empty outputs, no spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-motion-empty-"));
    try {
      const deps: MotionDeps = { spawnImpl: fakeSpawn() };
      const report = await composeMotion({ version: "1.0", cuts: [] }, { workDir: dir }, deps);
      expect(report.outputs).toEqual([]);
      expect(report.warnings.some((w) => w.includes("no cuts"))).toBe(true);
      expect(callsOf(deps.spawnImpl!)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces a warning + empty outputs when every motion render fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-motion-fail-"));
    try {
      const a = join(dir, "a.png");
      writeFileSync(a, "x");
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [{ id: "a", source: a, in_seconds: 0, out_seconds: 1, animation: "zoom-in" }],
        transition: "none",
      };
      const out = join(dir, "out.mp4");
      const report = await composeMotion(edit, { workDir: dir, output: out }, { spawnImpl: fakeSpawn({ motionExit: 1 }) });
      expect(report.outputs).toEqual([]);
      expect(report.warnings.some((w) => w.includes("motion render failed"))).toBe(true);
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mixes narration onto the silent bed when edit.audio.narration is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-motion-audio-"));
    try {
      const a = join(dir, "a.png");
      const narration = join(dir, "narration.mp3");
      writeFileSync(a, "x");
      writeFileSync(narration, "x");
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [{ id: "a", source: a, in_seconds: 0, out_seconds: 2, animation: "zoom-in" }],
        audio: { narration: { src: narration, volume: 0.8 } },
        transition: "none",
      };
      const out = join(dir, "out.mp4");
      const deps: MotionDeps = { spawnImpl: fakeSpawn() };
      const report = await composeMotion(edit, { workDir: dir, output: out }, deps);
      expect(report.outputs).toHaveLength(1);
      // The mix pass writes its result to its own timestamped path, but
      // composeMotion reconciles it back onto the caller-requested `out` so a
      // caller that trusts the path it passed in gets the real (mixed) file.
      expect(report.outputs[0]!.path).toBe(out);
      expect(existsSync(out)).toBe(true);
      expect(report.verification_notes.some((n) => n.includes("audio mixed"))).toBe(true);
      // The mix ffmpeg call carries atrim + volume (narration fit to duration).
      const calls = callsOf(deps.spawnImpl!);
      const mixCall = calls.find((c) => c.cmd === "ffmpeg" && c.argv.includes("-shortest") && c.argv.includes("-c:v") && c.argv.includes("copy"));
      expect(mixCall).toBeDefined();
      const fc = mixCall!.argv[mixCall!.argv.indexOf("-filter_complex") + 1];
      expect(fc).toContain("atrim");
      expect(fc).toContain("volume=0.8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns (does not crash) when narration src is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-motion-narr-missing-"));
    try {
      const a = join(dir, "a.png");
      writeFileSync(a, "x");
      const edit: RemotionEditDecisions = {
        version: "1.0",
        cuts: [{ id: "a", source: a, in_seconds: 0, out_seconds: 1, animation: "zoom-in" }],
        audio: { narration: { src: "/no/such.mp3" } },
        transition: "none",
      };
      const out = join(dir, "out.mp4");
      const report = await composeMotion(edit, { workDir: dir, output: out }, { spawnImpl: fakeSpawn() });
      expect(report.outputs).toHaveLength(1);
      expect(report.warnings.some((w) => w.includes("narration missing"))).toBe(true);
      // No mix ran → output stays the join path.
      expect(report.outputs[0]!.path).toBe(out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("composeMotion captions (drawtext ladder mirror)", () => {
  it("burns captions via the drawtext tier when libass is absent", async () => {
    // Pin the ladder: libass absent, drawtext present, font resolved → the motion
    // tier's captions sub-pass must hit drawtext (same ladder compose.ts uses).
    const { _setSubtitlesFilterForTest, _setDrawtextFilterForTest, _setCaptionFontForTest } = await import("./captions.ts");
    _setSubtitlesFilterForTest(false);
    _setDrawtextFilterForTest(true);
    _setCaptionFontForTest("/System/Library/Fonts/Supplemental/Arial.ttf");
    try {
      const dir = mkdtempSync(join(tmpdir(), "md-mocap-"));
      try {
        const src = join(dir, "src.mp4");
        const srt = join(dir, "c.srt");
        writeFileSync(src, "x");
        writeFileSync(srt, "1\n00:00:00,500 --> 00:00:01,500\nmotion caption\n");
        const edit: RemotionEditDecisions = {
          version: "1.0",
          cuts: [{ id: "a", type: "media", source: src, in_seconds: 0, out_seconds: 1, animation: "zoom-in" }],
          transition: "none",
        };
        const out = join(dir, "motion.mp4");
        const report = await composeMotion(
          edit,
          { workDir: dir, output: out, captions: { srtPath: srt, burn: true } },
          { spawnImpl: fakeSpawn() },
        );
        expect(report.outputs).toHaveLength(1);
        expect(report.verification_notes.some((n) => n.includes("burned (drawtext)"))).toBe(true);
        expect(report.warnings.some((w) => w.includes("libass"))).toBe(false);
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
