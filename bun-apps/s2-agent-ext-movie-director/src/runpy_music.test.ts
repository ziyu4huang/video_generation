import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMusicArgs, runPyMusic, type RunPyMusicOptions } from "./runpy_music.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "md-music-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildMusicArgs", () => {
  it("minimal: prompt + output only (run.py defaults duration/model)", () => {
    expect(buildMusicArgs({ prompt: "gentle piano" }, "/x/out.wav")).toEqual([
      "music", "--prompt", "gentle piano", "--output", "/x/out.wav",
    ]);
  });

  it("full: prompt + duration + model + output", () => {
    expect(
      buildMusicArgs({ prompt: "warm guitar", duration: 20, model: "facebook/musicgen-medium" }, "/x/out.wav"),
    ).toEqual([
      "music", "--prompt", "warm guitar", "--output", "/x/out.wav",
      "--duration", "20",
      "--model", "facebook/musicgen-medium",
    ]);
  });
});

describe("runPyMusic — spawn injection (no venv / no model)", () => {
  it("ok=true when run.py exits 0 AND the requested audio file lands with real content", async () => {
    const out = join(dir, "score.wav");
    const opts: RunPyMusicOptions = { prompt: "melancholic solo piano, slow", duration: 30, model: "facebook/musicgen-small" };
    const result = await runPyMusic({
      options: opts,
      output: out,
      _spawnImpl: async () => {
        writeFileSync(out, "fake wav bytes");
        return { stdout: "[music] ✓ saved: " + out, stderr: "", exitCode: 0 };
      },
    });
    expect(result.details.ok).toBe(true);
    expect(result.details.exitCode).toBe(0);
    expect(result.details.output).toBe(out);
    expect(result.details.sizeBytes).toBeGreaterThan(0);
    expect(result.details.model).toBe("facebook/musicgen-small");
    expect(result.details.duration).toBe(30);
    expect(result.summary).toContain("music ✓");
    expect(result.summary).toContain("facebook/musicgen-small");
  });

  it("ok=false when run.py exits 0 but wrote NO file (0-exit ≠ success)", async () => {
    const out = join(dir, "never-written.wav");
    const result = await runPyMusic({
      options: { prompt: "upbeat acoustic" },
      output: out,
      _spawnImpl: async () => ({ stdout: "[music] (nothing written)", stderr: "", exitCode: 0 }),
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.output).toBeNull();
    expect(result.summary).toContain("FAILED");
  });

  it("ok=false when run.py exits 0 but wrote an EMPTY file", async () => {
    const out = join(dir, "empty.wav");
    const result = await runPyMusic({
      options: { prompt: "ambient pad" },
      output: out,
      _spawnImpl: async () => {
        writeFileSync(out, "");
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.sizeBytes).toBe(0);
  });

  it("ok=false on non-zero exit (e.g. mlx-audiocraft missing)", async () => {
    const out = join(dir, "fail.wav");
    const result = await runPyMusic({
      options: { prompt: "x" },
      output: out,
      _spawnImpl: async () => ({ stdout: "", stderr: "ERROR: mlx-audiocraft not installed", exitCode: 1 }),
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.exitCode).toBe(1);
    expect(result.stderrTail).toContain("mlx-audiocraft");
  });

  it("ok=false + graceful summary when the spawn itself throws", async () => {
    const out = join(dir, "throw.wav");
    const result = await runPyMusic({
      options: { prompt: "x" },
      output: out,
      _spawnImpl: async () => {
        throw new Error("ENOENT: python");
      },
    });
    expect(result.details.ok).toBe(false);
    expect(result.summary).toContain("spawn failed");
    expect(result.summary).toContain("ENOENT");
  });
});
