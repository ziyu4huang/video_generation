import { describe, expect, it } from "bun:test";
import { runPyLipsync } from "./runpy_lipsync.ts";

describe("runPyLipsync — spawn injection (no venv)", () => {
  it("ok=true with parsed metrics on exit 0 + valid JSON stdout", async () => {
    const result = await runPyLipsync({
      videoPath: "/fake/shot.mp4",
      _spawnImpl: async () => ({
        stdout: JSON.stringify({
          verdict: "adequate",
          pearson_r: 0.55,
          mouth_ratio_std: 0.05,
        }),
        stderr: "",
        exitCode: 0,
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.metrics?.verdict).toBe("adequate");
    expect(result.metrics?.pearson_r).toBe(0.55);
    expect(result.metrics?.mouth_ratio_std).toBe(0.05);
    expect(result.error).toBeNull();
  });

  it("ok=true and preserves an optional caveat field", async () => {
    const result = await runPyLipsync({
      videoPath: "/fake/shot.mp4",
      _spawnImpl: async () => ({
        stdout: JSON.stringify({
          verdict: "inadequate",
          pearson_r: -0.35,
          mouth_ratio_std: 0.018,
          caveat: "pearson_r is strongly negative — anti-phase, not genuine lip-sync.",
        }),
        stderr: "",
        exitCode: 0,
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.metrics?.caveat).toContain("anti-phase");
  });

  it("ok=false on non-zero exit code", async () => {
    const result = await runPyLipsync({
      videoPath: "/fake/shot.mp4",
      _spawnImpl: async () => ({ stdout: "", stderr: "Traceback...", exitCode: 1 }),
    });
    expect(result.ok).toBe(false);
    expect(result.metrics).toBeNull();
    expect(result.error).toContain("exited 1");
    expect(result.stderrTail).toContain("Traceback");
  });

  it("ok=false on malformed JSON stdout", async () => {
    const result = await runPyLipsync({
      videoPath: "/fake/shot.mp4",
      _spawnImpl: async () => ({ stdout: "not json", stderr: "", exitCode: 0 }),
    });
    expect(result.ok).toBe(false);
    expect(result.metrics).toBeNull();
    expect(result.error).toContain("non-JSON");
  });

  it("ok=false when the spawn itself throws", async () => {
    const result = await runPyLipsync({
      videoPath: "/fake/shot.mp4",
      _spawnImpl: async () => {
        throw new Error("ENOENT: python not found");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.metrics).toBeNull();
    expect(result.error).toContain("ENOENT");
  });
});
