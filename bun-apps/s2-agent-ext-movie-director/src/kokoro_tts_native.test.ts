import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildKokoroTtsArgs, runKokoroTtsNative } from "./kokoro_tts_native.ts";
import type { KokoroTtsOptions } from "./kokoro_tts_native.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "md-kokoro-tts-native-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildKokoroTtsArgs", () => {
  it("minimal: text + voice + output only (speed/modelRepo default in the CLI)", () => {
    expect(buildKokoroTtsArgs({ text: "hello", voice: "af_heart" }, "/x/out.wav")).toEqual([
      "generate", "--text", "hello", "--voice", "af_heart", "--output", "/x/out.wav",
    ]);
  });

  it("includes --speed when set", () => {
    const args = buildKokoroTtsArgs({ text: "hi", voice: "am_michael", speed: 1.2 }, "/x/out.wav");
    expect(args).toEqual([
      "generate", "--text", "hi", "--voice", "am_michael", "--output", "/x/out.wav",
      "--speed", "1.2",
    ]);
  });

  it("includes --model-repo when set", () => {
    const args = buildKokoroTtsArgs(
      { text: "hi", voice: "zf_xiaobei", modelRepo: "mlx-community/Kokoro-82M-4bit" },
      "/x/out.wav",
    );
    expect(args).toEqual([
      "generate", "--text", "hi", "--voice", "zf_xiaobei", "--output", "/x/out.wav",
      "--model-repo", "mlx-community/Kokoro-82M-4bit",
    ]);
  });
});

describe("runKokoroTtsNative — spawn injection (no built binary needed)", () => {
  it("ok=true when the binary exits 0 AND the requested audio file lands with real content", async () => {
    const out = join(dir, "line.wav");
    const opts: KokoroTtsOptions = { text: "Hello from Kokoro.", voice: "af_heart" };
    const result = await runKokoroTtsNative({
      options: opts,
      output: out,
      _spawnImpl: async () => {
        writeFileSync(out, "fake wav bytes");
        return { stdout: "generated", stderr: "", exitCode: 0 };
      },
    });
    expect(result.details.ok).toBe(true);
    expect(result.details.command).toBe("tts");
    expect(result.details.exitCode).toBe(0);
    expect(result.details.output).toBe(out);
    expect(result.details.sizeBytes).toBeGreaterThan(0);
    expect(result.details.voice).toBe("af_heart");
    expect(result.summary).toContain("kokoro ✓");
  });

  it("ok=false when the binary exits 0 but wrote NO file (0-exit ≠ success)", async () => {
    const out = join(dir, "never-written.wav");
    const result = await runKokoroTtsNative({
      options: { text: "x", voice: "af_heart" },
      output: out,
      _spawnImpl: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.output).toBeNull();
    expect(result.summary).toContain("FAILED");
  });

  it("ok=false when the binary exits 0 but wrote an EMPTY file", async () => {
    const out = join(dir, "empty.wav");
    const result = await runKokoroTtsNative({
      options: { text: "x", voice: "af_heart" },
      output: out,
      _spawnImpl: async () => {
        writeFileSync(out, "");
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.sizeBytes).toBe(0);
  });

  it("ok=false on non-zero exit (e.g. model download failed)", async () => {
    const out = join(dir, "fail.wav");
    const result = await runKokoroTtsNative({
      options: { text: "x", voice: "zm_yunjian" },
      output: out,
      _spawnImpl: async () => ({ stdout: "", stderr: "ERROR: could not resolve repo", exitCode: 1 }),
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.exitCode).toBe(1);
    expect(result.stderrTail).toContain("could not resolve repo");
  });

  it("ok=false + graceful summary when the spawn itself throws", async () => {
    const out = join(dir, "throw.wav");
    const result = await runKokoroTtsNative({
      options: { text: "x", voice: "af_heart" },
      output: out,
      _spawnImpl: async () => {
        throw new Error("ENOENT: kokoro-tts binary");
      },
    });
    expect(result.details.ok).toBe(false);
    expect(result.summary).toContain("spawn failed");
    expect(result.summary).toContain("ENOENT");
  });

  it("ok=false + does NOT spawn when voice is empty (validated before the binary is invoked)", async () => {
    const out = join(dir, "no-voice.wav");
    let spawnCalls = 0;
    const result = await runKokoroTtsNative({
      options: { text: "x", voice: "" },
      output: out,
      _spawnImpl: async () => {
        spawnCalls++;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    expect(result.details.ok).toBe(false);
    expect(result.summary).toContain("voice is required");
    expect(spawnCalls).toBe(0);
  });
});
