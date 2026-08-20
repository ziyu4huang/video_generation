import { describe, expect, it } from "bun:test";
import { buildLipsyncArgs, runPyLipsync } from "./lipsync_metrics.ts";

describe("buildLipsyncArgs", () => {
  it("builds the exact ltx-video lipsync-metrics argv", () => {
    expect(buildLipsyncArgs("/fake/shot.mp4")).toEqual(["lipsync-metrics", "/fake/shot.mp4", "--json"]);
  });
});

describe("runPyLipsync — spawn injection (no built binary needed)", () => {
  it("ok=true with parsed metrics on exit 0 + valid JSON stdout", async () => {
    let capturedArgs: string[] = [];
    const result = await runPyLipsync({
      videoPath: "/fake/shot.mp4",
      _spawnImpl: async (args) => {
        capturedArgs = args;
        return {
          stdout: JSON.stringify({
            verdict: "adequate",
            pearson_r: 0.55,
            mouth_ratio_std: 0.05,
          }),
          stderr: "",
          exitCode: 0,
        };
      },
    });
    expect(capturedArgs).toEqual(["lipsync-metrics", "/fake/shot.mp4", "--json"]);
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

  it("ok=true when verdict is no_face/no_audio with pearson_r/mouth_ratio_std absent (not null)", async () => {
    const result = await runPyLipsync({
      videoPath: "/fake/shot.mp4",
      _spawnImpl: async () => ({
        stdout: JSON.stringify({
          verdict: "no_face",
          note: "No face detected in any sampled frame.",
          n_frames: 73,
          n_detected: 0,
        }),
        stderr: "",
        exitCode: 0,
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.metrics?.verdict).toBe("no_face");
    expect(result.metrics?.note).toContain("No face detected");
    expect(result.metrics?.pearson_r).toBeUndefined();
    expect(result.metrics?.mouth_ratio_std).toBeUndefined();
  });

  it("ok=false on non-zero exit code", async () => {
    const result = await runPyLipsync({
      videoPath: "/fake/shot.mp4",
      _spawnImpl: async () => ({ stdout: "", stderr: "Fatal error...", exitCode: 1 }),
    });
    expect(result.ok).toBe(false);
    expect(result.metrics).toBeNull();
    expect(result.error).toContain("exited 1");
    expect(result.stderrTail).toContain("Fatal error");
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
        throw new Error("ENOENT: ltx-video not found");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.metrics).toBeNull();
    expect(result.error).toContain("ENOENT");
  });
});
