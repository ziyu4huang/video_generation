import { describe, expect, it } from "bun:test";
import { parseFps, probeDuration, probeMedia } from "./ffprobe.ts";
import type { SpawnResult } from "./spawn.ts";

function fakeSpawn(result: SpawnResult): () => Promise<SpawnResult> {
  return () => Promise.resolve(result);
}

describe("parseFps", () => {
  it("parses an N/D fraction", () => {
    expect(parseFps("30/1")).toBe(30);
    expect(parseFps("24000/1001")).toBeCloseTo(23.976, 2);
  });

  it("returns undefined for an unparseable fraction", () => {
    expect(parseFps("not/a/fraction")).toBeUndefined();
    expect(parseFps("30/0")).toBeUndefined();
    expect(parseFps("")).toBeUndefined();
  });
});

describe("probeMedia", () => {
  it("parses a well-formed ffprobe JSON payload", async () => {
    const run = fakeSpawn({
      code: 0,
      stdout: JSON.stringify({
        format: { duration: "12.5", format_name: "mov,mp4,m4a" },
        streams: [
          { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1" },
          { codec_type: "audio", codec_name: "aac" },
        ],
      }),
      stderr: "",
    });
    const r = await probeMedia("/fake.mp4", run);
    expect(r.duration).toBe(12.5);
    expect(r.format).toBe("mov");
    expect(r.videoCodec).toBe("h264");
    expect(r.audioCodec).toBe("aac");
    expect(r.resolution).toBe("1920x1080");
    expect(r.fps).toBe(30);
  });

  it("returns { duration: 0 } — never throws — when ffprobe exits non-zero", async () => {
    const run = fakeSpawn({ code: 1, stdout: "", stderr: "no such file" });
    const r = await probeMedia("/missing.mp4", run);
    expect(r).toEqual({ duration: 0 });
  });

  it("returns { duration: 0 } — never throws — on unparseable JSON", async () => {
    const run = fakeSpawn({ code: 0, stdout: "not json", stderr: "" });
    const r = await probeMedia("/fake.mp4", run);
    expect(r).toEqual({ duration: 0 });
  });

  it("omits optional fields when no video/audio stream is present", async () => {
    const run = fakeSpawn({
      code: 0,
      stdout: JSON.stringify({ format: { duration: "3.0" }, streams: [] }),
      stderr: "",
    });
    const r = await probeMedia("/audioless.mp4", run);
    expect(r.duration).toBe(3);
    expect(r.videoCodec).toBeUndefined();
    expect(r.audioCodec).toBeUndefined();
    expect(r.resolution).toBeUndefined();
    expect(r.fps).toBeUndefined();
  });
});

describe("probeDuration", () => {
  it("parses a plain-number stdout", async () => {
    const run = fakeSpawn({ code: 0, stdout: "7.25\n", stderr: "" });
    expect(await probeDuration("/fake.mp4", run)).toBe(7.25);
  });

  it("returns 0 — never throws — on ffprobe failure", async () => {
    const run = fakeSpawn({ code: 1, stdout: "", stderr: "boom" });
    expect(await probeDuration("/missing.mp4", run)).toBe(0);
  });

  it("returns 0 for non-numeric or non-positive stdout", async () => {
    expect(await probeDuration("/x.mp4", fakeSpawn({ code: 0, stdout: "N/A\n", stderr: "" }))).toBe(0);
    expect(await probeDuration("/x.mp4", fakeSpawn({ code: 0, stdout: "0\n", stderr: "" }))).toBe(0);
    expect(await probeDuration("/x.mp4", fakeSpawn({ code: 0, stdout: "-1\n", stderr: "" }))).toBe(0);
  });
});
