import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMusicNativeArgs, runMusicNative } from "./music_native.ts";
import type { RunPyMusicOptions } from "./runpy_music.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "md-music-native-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildMusicNativeArgs", () => {
  it("minimal: prompt + output only (musicgen defaults duration)", () => {
    expect(buildMusicNativeArgs({ prompt: "gentle piano" }, "/x/out.wav")).toEqual([
      "generate", "--prompt", "gentle piano", "--output", "/x/out.wav",
    ]);
  });

  it("includes --duration when set", () => {
    const args = buildMusicNativeArgs({ prompt: "warm guitar", duration: 20 }, "/x/out.wav");
    expect(args).toEqual([
      "generate", "--prompt", "warm guitar", "--output", "/x/out.wav",
      "--duration", "20",
    ]);
  });

  it("does not pass --model (v1 Swift binary is musicgen-small only)", () => {
    const args = buildMusicNativeArgs(
      { prompt: "x", model: "facebook/musicgen-medium" } as RunPyMusicOptions,
      "/x/out.wav",
    );
    expect(args).not.toContain("--model");
  });
});

describe("runMusicNative — spawn injection (no built binary needed)", () => {
  it("ok=true when the binary exits 0 AND the requested audio file lands with real content", async () => {
    const out = join(dir, "score.wav");
    const opts: RunPyMusicOptions = { prompt: "melancholic solo piano, slow", duration: 30 };
    const result = await runMusicNative({
      options: opts,
      output: out,
      _spawnImpl: async () => {
        writeFileSync(out, "fake wav bytes");
        return { stdout: "generated", stderr: "", exitCode: 0 };
      },
    });
    expect(result.details.ok).toBe(true);
    expect(result.details.exitCode).toBe(0);
    expect(result.details.output).toBe(out);
    expect(result.details.sizeBytes).toBeGreaterThan(0);
    expect(result.details.model).toBe("musicgen-small");
    expect(result.details.duration).toBe(30);
    expect(result.summary).toContain("music ✓");
    expect(result.summary).toContain("Swift native");
  });

  it("ok=false when the binary exits 0 but wrote NO file (0-exit ≠ success)", async () => {
    const out = join(dir, "never-written.wav");
    const result = await runMusicNative({
      options: { prompt: "upbeat acoustic" },
      output: out,
      _spawnImpl: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.output).toBeNull();
    expect(result.summary).toContain("FAILED");
  });

  it("ok=false when the binary exits 0 but wrote an EMPTY file", async () => {
    const out = join(dir, "empty.wav");
    const result = await runMusicNative({
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

  it("ok=false on non-zero exit (e.g. model dir missing)", async () => {
    const out = join(dir, "fail.wav");
    const result = await runMusicNative({
      options: { prompt: "x" },
      output: out,
      _spawnImpl: async () => ({ stdout: "", stderr: "ERROR: model-dir not found", exitCode: 1 }),
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.exitCode).toBe(1);
    expect(result.stderrTail).toContain("model-dir not found");
  });

  it("ok=false + graceful summary when the spawn itself throws", async () => {
    const out = join(dir, "throw.wav");
    const result = await runMusicNative({
      options: { prompt: "x" },
      output: out,
      _spawnImpl: async () => {
        throw new Error("ENOENT: musicgen binary");
      },
    });
    expect(result.details.ok).toBe(false);
    expect(result.summary).toContain("spawn failed");
    expect(result.summary).toContain("ENOENT");
  });
});
