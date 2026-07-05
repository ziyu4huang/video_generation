import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSrt, planBurn, burnCaptions, stripSrtMarkup, wrapCueText, _setSubtitlesFilterForTest, _setDrawtextFilterForTest, _setCaptionFontForTest } from "./captions.ts";

beforeAll(() => {
  _setSubtitlesFilterForTest(true);
  _setDrawtextFilterForTest(true);
  _setCaptionFontForTest("/System/Library/Fonts/Supplemental/Arial.ttf");
});
afterAll(() => {
  _setSubtitlesFilterForTest(undefined);
  _setDrawtextFilterForTest(undefined);
  _setCaptionFontForTest(undefined);
});

describe("parseSrt", () => {
  it("parses an SRT with comma millisecond timestamps", () => {
    const srt = ["1", "00:00:00,500 --> 00:00:01,750", "first cue", "", "2", "00:01:02,000 --> 00:01:05,250", "second"].join("\n");
    const cues = parseSrt(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.start).toBe(0.5);
    expect(cues[0]!.end).toBe(1.75);
    expect(cues[0]!.text).toBe("first cue");
    expect(cues[1]!.start).toBe(62);
    expect(cues[1]!.end).toBe(65.25);
  });

  it("joins multi-line cue text and drops malformed blocks", () => {
    const srt = [
      "1", "00:00:01,000 --> 00:00:02,000", "line one", "line two", "",
      "2", "not a time line at all", "should be skipped", "",
      "3", "00:00:03,000 --> 00:00:04,000", "third",
    ].join("\n");
    const cues = parseSrt(srt);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.text).toBe("line one\nline two");
    expect(cues[1]!.text).toBe("third");
  });

  it("parses VTT dot millisecond timestamps too", () => {
    const cues = parseSrt("00:00:00.000 --> 00:00:00.500\nhi");
    expect(cues).toHaveLength(1);
    expect(cues[0]!.end).toBe(0.5);
  });

  it("strips SRT/ASS inline markup (drawtext would burn it as raw text)", () => {
    const srt = "1\n00:00:00,000 --> 00:00:01,000\n<i>italic</i> and <b>bold</b> {\\an8}plain";
    const cues = parseSrt(srt);
    expect(cues[0]!.text).toBe("italic and bold plain");
  });
});

describe("stripSrtMarkup", () => {
  it("removes <i>/<b>/<u>/<font> and ASS override blocks", () => {
    expect(stripSrtMarkup("<i>hi</i>")).toBe("hi");
    expect(stripSrtMarkup("<b>x</b>")).toBe("x");
    expect(stripSrtMarkup("<u>under</u>")).toBe("under");
    expect(stripSrtMarkup("<font color=\"#fff\">f</font>")).toBe("f");
    expect(stripSrtMarkup("{\\an8}top")).toBe("top");
    expect(stripSrtMarkup("{\\b1}bold{\\b0}")).toBe("bold");
    expect(stripSrtMarkup("clean text")).toBe("clean text");
  });
});

describe("wrapCueText", () => {
  it("word-wraps a long cue to the per-line char budget", () => {
    const wrapped = wrapCueText("the quick brown fox jumps over the lazy dog", 20);
    // No line exceeds 20 chars; word boundaries respected.
    for (const line of wrapped.split("\n")) expect(line.length).toBeLessThanOrEqual(20);
    expect(wrapped).toContain("\n");
    // All original words survive.
    expect(wrapped.replace(/\n/g, " ")).toBe("the quick brown fox jumps over the lazy dog");
  });

  it("preserves explicit single-line cues under budget", () => {
    expect(wrapCueText("short cue", 40)).toBe("short cue");
  });

  it("preserves explicit newlines, wrapping each segment independently", () => {
    const out = wrapCueText("first segment line\nsecond segment", 12);
    expect(out.startsWith("first\n")).toBe(true);
    expect(out).toContain("second");
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(12);
  });
});

describe("planBurn", () => {
  it("libass tier when subtitles filter available", () => {
    _setSubtitlesFilterForTest(true);
    _setDrawtextFilterForTest(true);
    expect(planBurn(true, true).outcome).toBe("libass");
  });
  it("drawtext tier when libass absent but drawtext+font resolve", () => {
    _setSubtitlesFilterForTest(false);
    _setDrawtextFilterForTest(true);
    _setCaptionFontForTest("/fonts/Arial.ttf");
    expect(planBurn(true, true).outcome).toBe("drawtext");
  });
  it("sidecar tier + warning when both filters absent (the macOS stock case)", () => {
    _setSubtitlesFilterForTest(false);
    _setDrawtextFilterForTest(false);
    const p = planBurn(true, true);
    expect(p.outcome).toBe("sidecar");
    expect(p.warning).toContain("libass");
    expect(p.warning).toContain("drawtext");
  });
  it("sidecar tier when wantBurn is false (caller asked for soft captions)", () => {
    expect(planBurn(false, true).outcome).toBe("sidecar");
  });
  it("skip when the srt file is absent", () => {
    expect(planBurn(true, false).outcome).toBe("skip");
  });
});

describe("burnCaptions (mocked)", () => {
  function fakeSpawn() {
    return async (cmd: string, argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      // Real-encode shape: last arg is the output path → write a placeholder.
      const out = argv[argv.length - 1];
      if (out && !out.startsWith("-")) writeFileSync(out, "x");
      return { code: 0, stdout: "", stderr: "" };
    };
  }

  it("drawtext burn argv contains a drawtext node per cue with enable=between", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-cap-burn-"));
    try {
      const video = join(dir, "v.mp4");
      const srt = join(dir, "c.srt");
      const out = join(dir, "o.mp4");
      writeFileSync(video, "x");
      writeFileSync(srt, "1\n00:00:01,000 --> 00:00:02,000\nburned!\n");
      _setSubtitlesFilterForTest(false);
      _setDrawtextFilterForTest(true);
      _setCaptionFontForTest("/fonts/Arial.ttf");
      const calls: string[][] = [];
      const spawn = fakeSpawn();
      const r = await burnCaptions(video, srt, out, true, {
        spawnImpl: async (cmd, argv) => { calls.push(argv); return spawn(cmd, argv); },
      });
      expect(r.ok).toBe(true);
      expect(r.outcome).toBe("drawtext");
      const argv = calls[0]!;
      expect(argv.some((a) => a.startsWith("drawtext=") && a.includes("enable='between(t,1.000,2.000)'"))).toBe(true);
      expect(argv.some((a) => a === "-c:a" && argv[argv.indexOf(a) + 1] === "copy")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sidecar burn when drawtext absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-cap-side2-"));
    try {
      const video = join(dir, "v.mp4");
      const srt = join(dir, "c.srt");
      const out = join(dir, "o.mp4");
      writeFileSync(video, "x");
      writeFileSync(srt, "1\n00:00:01,000 --> 00:00:02,000\nhi\n");
      _setSubtitlesFilterForTest(false);
      _setDrawtextFilterForTest(false);
      const r = await burnCaptions(video, srt, out, true, { spawnImpl: fakeSpawn() });
      expect(r.ok).toBe(true);
      expect(r.outcome).toBe("sidecar");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drawtext wraps a long cue to the frame width (multi-line text)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "md-cap-wrap-"));
    try {
      const video = join(dir, "v.mp4");
      const srt = join(dir, "c.srt");
      const out = join(dir, "o.mp4");
      writeFileSync(video, "x");
      // A cue longer than the small frame width — must word-wrap.
      writeFileSync(srt, "1\n00:00:01,000 --> 00:00:02,000\nthe quick brown fox jumps over the lazy dog\n");
      _setSubtitlesFilterForTest(false);
      _setDrawtextFilterForTest(true);
      _setCaptionFontForTest("/fonts/Arial.ttf");
      const calls: string[][] = [];
      const spawn = fakeSpawn();
      const r = await burnCaptions(video, srt, out, true, {
        spawnImpl: async (cmd, argv) => { calls.push(argv); return spawn(cmd, argv); },
        width: 320,
        fontsize: 48,
      });
      expect(r.ok).toBe(true);
      expect(r.outcome).toBe("drawtext");
      // The drawtext text carries an escaped line break (\\n) — the cue wrapped.
      const node = calls[0]!.find((a) => a.startsWith("drawtext="))!;
      expect(node).toContain("\\n");
      // Sanity: a small width + this cue cannot fit on one line.
      expect(node.includes("the quick brown fox jumps over the lazy dog")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
