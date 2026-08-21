import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildKokoroTtsArgs,
	chunkNarration,
	concatWavFiles,
	defaultKokoroVoice,
	runKokoroTtsNative,
} from "./kokoro_tts_native.ts";
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

  it("empty voice falls back to the language-aware default (en text → af_heart)", async () => {
    const out = join(dir, "default-voice.wav");
    const result = await runKokoroTtsNative({
      options: { text: "Hello there.", voice: "" },
      output: out,
      _spawnImpl: async () => {
        writeFileSync(out, "fake wav bytes");
        return { stdout: "generated", stderr: "", exitCode: 0 };
      },
    });
    expect(result.details.ok).toBe(true);
    expect(result.details.voice).toBe("af_heart");
  });

  it("empty voice falls back to the language-aware default (zh text → zf_xiaobei)", async () => {
    const out = join(dir, "default-voice-zh.wav");
    const result = await runKokoroTtsNative({
      options: { text: "這是一段中文旁白,用來測試預設聲音。" },
      output: out,
      _spawnImpl: async () => {
        writeFileSync(out, "fake wav bytes");
        return { stdout: "generated", stderr: "", exitCode: 0 };
      },
    });
    expect(result.details.ok).toBe(true);
    expect(result.details.voice).toBe("zf_xiaobei");
  });
});

describe("chunkNarration — long-text chunking (g2p 510-token cap)", () => {
  it("short text stays a single chunk", () => {
    expect(chunkNarration("Hello from Kokoro.")).toEqual(["Hello from Kokoro."]);
  });

  it("CJK-dominant long text splits at sentence boundaries under the CJK limit", () => {
    const sentence = "這是一個測試句子,用來驗證分段邏輯。";
    const text = sentence.repeat(12); // ~14 chars × 12 = ~168 chars > 120
    const chunks = chunkNarration(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(120);
    // concatenation preserves all sentences in order
    expect(chunks.join("")).toBe(text);
  });

  it("latin text uses the larger limit and keeps sentence boundaries", () => {
    const sentence = "The model denoises one step at a time. ";
    const text = sentence.repeat(20); // ~1.4k chars > 400
    const chunks = chunkNarration(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(400);
    // chunk-boundary trailing spaces are trimmed — re-insert one space at the
    // join before comparing
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
  });

  it("a single over-limit sentence without boundary punctuation is hard-split", () => {
    const text = "字".repeat(300); // one "sentence", no delimiters
    const chunks = chunkNarration(text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(120);
    expect(chunks.join("")).toBe(text);
  });

  it("empty/whitespace input yields no chunks", () => {
    expect(chunkNarration("")).toEqual([]);
    expect(chunkNarration("   ")).toEqual([]);
  });
});

describe("concatWavFiles — PCM WAV concatenation", () => {
  function miniWav(samples: number[]): Buffer {
    // 16-bit mono PCM, 24kHz, canonical 44-byte header
    const data = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + data.length, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(24000, 24);
    header.writeUInt32LE(48000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
  }

  it("concatenates two same-format WAVs into one valid PCM WAV", () => {
    const a = join(dir, "c1.wav");
    const b = join(dir, "c2.wav");
    const out = join(dir, "cat.wav");
    writeFileSync(a, miniWav([100, -100, 50]));
    writeFileSync(b, miniWav([25, -25]));
    concatWavFiles([a, b], out);
    const buf = readFileSync(out);
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.readUInt32LE(40)).toBe(10); // 5 samples × 2 bytes
    expect(buf.length).toBe(54);
  });
});

describe("runKokoroTtsNative — multi-chunk synthesis", () => {
  it("long CJK text spawns once per chunk, concatenates, and cleans up temp parts", async () => {
    const out = join(dir, "multi.wav");
    const text = "這是一個測試句子,用來驗證分段邏輯。".repeat(12);
    let spawnCalls = 0;
    const result = await runKokoroTtsNative({
      options: { text },
      output: out,
      _spawnImpl: async (_args) => {
        spawnCalls++;
        const m = /--output (\S+)/.exec(_args.join(" "));
        writeFileSync(m![1]!, "x".repeat(58)); // >44 bytes: RIFF-ish content, fine for ok check
        return { stdout: "generated", stderr: "", exitCode: 0 };
      },
    });
    expect(spawnCalls).toBeGreaterThan(1);
    // The fake part content is not a parseable WAV, so concatenation fails
    // gracefully (ok=false, actionable summary) — and the temp parts are
    // cleaned up either way.
    expect(result.details.ok).toBe(false);
    expect(result.summary).toContain("concatenate");
    expect(existsSync(`${out}.part0.wav`)).toBe(false);
    expect(result.details.output ?? "").not.toContain(".part");
  });
});
