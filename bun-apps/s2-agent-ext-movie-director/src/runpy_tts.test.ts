import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTtsArgs, runPyTts, type RunPyTtsOptions } from "./runpy_tts.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "md-tts-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildTtsArgs", () => {
  it("minimal: text + output only (run.py defaults voice/rate)", () => {
    expect(buildTtsArgs({ text: "hello" }, "/x/out.mp3")).toEqual([
      "tts", "--text", "hello", "--output", "/x/out.mp3",
    ]);
  });

  it("full: text + voice + rate + output", () => {
    expect(
      buildTtsArgs({ text: "hello", voice: "en-US-GuyNeural", rate: "-10%" }, "/x/out.mp3"),
    ).toEqual([
      "tts", "--text", "hello", "--output", "/x/out.mp3",
      "--voice", "en-US-GuyNeural",
      "--rate", "-10%",
    ]);
  });
});

describe("runPyTts — spawn injection (no venv / no network)", () => {
  it("ok=true when run.py exits 0 AND the requested audio file lands with real content", async () => {
    const out = join(dir, "narration.mp3");
    const opts: RunPyTtsOptions = { text: "A neural network isn't smart on day one.", voice: "en-US-AriaNeural" };
    const result = await runPyTts({
      options: opts,
      output: out,
      // Simulate run.py's edge-tts synthesis writing the file as a side effect.
      _spawnImpl: async () => {
        writeFileSync(out, "fake mp3 bytes");
        return { stdout: "[tts] ✓ saved: " + out, stderr: "", exitCode: 0 };
      },
    });
    expect(result.details.ok).toBe(true);
    expect(result.details.exitCode).toBe(0);
    expect(result.details.output).toBe(out);
    expect(result.details.sizeBytes).toBeGreaterThan(0);
    expect(result.details.voice).toBe("en-US-AriaNeural");
    expect(result.summary).toContain("tts ✓");
    expect(result.summary).toContain("en-US-AriaNeural");
  });

  it("ok=false when run.py exits 0 but wrote NO file (0-exit ≠ success)", async () => {
    const out = join(dir, "never-written.mp3");
    const result = await runPyTts({
      options: { text: "hello" },
      output: out,
      _spawnImpl: async () => ({ stdout: "[tts] (nothing written)", stderr: "", exitCode: 0 }),
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.output).toBeNull();
    expect(result.summary).toContain("FAILED");
  });

  it("ok=false when run.py exits 0 but wrote an EMPTY file (edge-tts silent failure)", async () => {
    const out = join(dir, "empty.mp3");
    const result = await runPyTts({
      options: { text: "hello" },
      output: out,
      _spawnImpl: async () => {
        writeFileSync(out, "");
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    expect(result.details.ok).toBe(false);
    // The empty file DOES exist (details.output/sizeBytes reflect that), but ok
    // is false because sizeBytes > 0 is required for success.
    expect(result.details.sizeBytes).toBe(0);
  });

  it("ok=false on non-zero exit (e.g. network unreachable)", async () => {
    const out = join(dir, "fail.mp3");
    const result = await runPyTts({
      options: { text: "hello" },
      output: out,
      _spawnImpl: async () => ({ stdout: "", stderr: "boom: network unreachable", exitCode: 1 }),
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.exitCode).toBe(1);
    expect(result.stderrTail).toContain("boom");
  });

  it("ok=false + graceful summary when the spawn itself throws", async () => {
    const out = join(dir, "throw.mp3");
    const result = await runPyTts({
      options: { text: "hello" },
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
