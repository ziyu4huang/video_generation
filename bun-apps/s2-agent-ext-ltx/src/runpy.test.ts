/**
 * runpy.test.ts — unit tests for the run.py video adapter (Option A).
 *
 * Drives runPyVideo() with a TEST-ONLY spawn injection (_spawnImpl) so no real
 * run.py / venv is needed: the test feeds canned stdout carrying the
 * `[t2i2v] manifest: <path>` marker, writes a fake manifest JSON + a fake mp4,
 * and asserts the adapter parses the mp4 + model id correctly. Mirrors the
 * whisper/clip/esrgan adapters' injection pattern.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runPyVideo, resolveRunPyPaths } from "./runpy.ts";
import { resolveRepoRoot } from "./binary.ts";
import { PathSafetyError } from "./paths.ts";
import type { InvokeResult } from "./invoke.ts";

/**
 * paths.ts requires an outputDir override to resolve under the repo root OR its
 * parent dir (the externalized-store convention). The OS tmpdir is outside that
 * sandbox, so sandboxes live under the repo parent instead.
 */
const REPO_PARENT = dirname(resolveRepoRoot());
const newBox = () => mkdtempSync(join(REPO_PARENT, "runpy-test-"));

/** Build a fake successful InvokeResult whose stdout carries the manifest marker. */
function fakeOk(runDir: string, manifestPath: string): InvokeResult {
  return {
    exitCode: 0,
    stdout:
      `[t2i2v] Stage 1: T2I (ZImage) …\n` +
      `[t2i2v] Stage 2: VLM …\n` +
      `[t2i2v] Stage 3: I2V (LTX) …\n` +
      `[t2i2v] ✓ Done → ${runDir}\n` +
      `[t2i2v]   manifest: ${manifestPath}\n`,
    stderr: "",
    output: "",
    aborted: false,
  };
}

describe("runPyVideo (run.py video t2i2v adapter)", () => {
  test("parses manifest marker + mp4 + i2v model on exit 0", async () => {
    const repoRoot = resolveRepoRoot();
    const box = newBox();
    const runDir = join(box, "t2i2v_test");
    mkdirSync(runDir, { recursive: true });
    const manifestPath = join(runDir, "t2i2v_manifest.json");
    const mp4 = join(runDir, "final.mp4");
    writeFileSync(mp4, "FAKE_MP4_BYTES");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        pipeline: "t2i2v",
        output_dir: runDir,
        stages: {
          t2i: { transformer: "z-image", seed: 42, image_path: join(runDir, "t2i.png") },
          vlm: { action: "她微笑", generated_prompt: "smiling woman", skipped: false, vlm_ok: true },
          i2v: { transformer: "dasiwa", prompt: "smiling woman", frames: 49, fps: 24, seed: 42 },
          quality: { skipped: true },
        },
      }),
    );

    try {
      const out = await runPyVideo({
        options: { selfTest: "default" },
        outputDir: box,
        _spawnImpl: async ({ bin, args }) => {
          // Assert the spawn targets the venv python + run.py script + video t2i2v.
          const { python, runPy } = resolveRunPyPaths(repoRoot);
          expect(bin).toBe(python);
          expect(args[0]).toBe(runPy); // run.py is the SCRIPT path (spawn(python, [runPy, …]))
          expect(args[1]).toBe("video");
          expect(args[2]).toBe("t2i2v");
          expect(args).toContain("--self-test");
          expect(args).toContain("default");
          expect(args.some((a, i) => a === "--gen-output-dir" && args[i + 1] === box)).toBe(true);
          return fakeOk(runDir, manifestPath);
        },
      });

      expect(out.details.ok).toBe(true);
      expect(out.details.exitOk).toBe(true);
      expect(out.details.mp4Exists).toBe(true);
      expect(out.details.output).toBe(mp4);
      expect(out.details.outDir).toBe(runDir);
      // model pulled from the manifest's i2v stage (local silicon, never cloud).
      expect(out.details.model).toBe("dasiwa");
      expect(out.summary).toContain(mp4);
      expect(out.summary).toContain("✓");
    } finally {
      rmSync(box, { recursive: true, force: true });
    }
  });

  test("ok=false when run.py exits non-zero (no manifest, no mp4)", async () => {
    const box = newBox();
    try {
      const out = await runPyVideo({
        options: { prompt: "x" },
        outputDir: box,
        _spawnImpl: async () => ({
          exitCode: 2,
          stdout: "[t2i2v] ERROR: T2I stage failed (exit 1)",
          stderr: "Traceback ... ModuleNotFoundError: mlx",
          output: "",
          aborted: false,
        }),
      });
      expect(out.details.ok).toBe(false);
      expect(out.details.exitOk).toBe(false);
      expect(out.details.output).toBeNull();
      expect(out.details.model).toBeNull();
      expect(out.summary).toContain("exited 2");
      expect(out.stderrTail).toContain("ModuleNotFoundError");
    } finally {
      rmSync(box, { recursive: true, force: true });
    }
  });

  test("ok=false on exit 0 but no mp4 (review/empty run is not a generation success)", async () => {
    const box = newBox();
    const runDir = join(box, "t2i2v_review");
    mkdirSync(runDir, { recursive: true });
    const manifestPath = join(runDir, "t2i2v_manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ pipeline: "t2i2v", output_dir: runDir, stages: {} }));
    try {
      // No options: this asserts the exit-0-without-mp4 gate, and nothing else.
      // It used to pass `{ reviewRuns: true }`, which is not a RunPyVideoOptions
      // field and which buildArgs never emits — inert decoration that only read
      // as meaningful because no typechecker had ever seen this file.
      const out = await runPyVideo({
        options: {},
        outputDir: box,
        _spawnImpl: async () => ({
          exitCode: 0,
          stdout: `[t2i2v review] scanned 3 runs\n[t2i2v]   manifest: ${manifestPath}\n`,
          stderr: "",
          output: "",
          aborted: false,
        }),
      });
      // exitOk but mp4Exists false → ok false (the gate is "real MP4 produced").
      expect(out.details.exitOk).toBe(true);
      expect(out.details.mp4Exists).toBe(false);
      expect(out.details.ok).toBe(false);
      expect(out.summary).toContain("no mp4");
    } finally {
      rmSync(box, { recursive: true, force: true });
    }
  });

  test("buildArgs: --self-test true runs ALL fixtures (no name token)", async () => {
    const box = newBox();
    let captured: string[] = [];
    try {
      await runPyVideo({
        options: { selfTest: true },
        outputDir: box,
        _spawnImpl: async ({ args }) => {
          captured = args;
          return { exitCode: 0, stdout: "", stderr: "", output: "", aborted: false };
        },
      });
      const stIdx = captured.indexOf("--self-test");
      expect(stIdx).toBeGreaterThanOrEqual(0);
      // bare --self-test → the NEXT token must be another flag (not a fixture name).
      expect(captured[stIdx + 1]).toStrictEqual(expect.stringMatching(/^--/));
    } finally {
      rmSync(box, { recursive: true, force: true });
    }
  });

  test("rejects a fromImage path outside the allowed roots (path-confinement)", async () => {
    const box = newBox();
    try {
      await expect(
        runPyVideo({
          options: { fromImage: "/etc/passwd" },
          outputDir: box,
          _spawnImpl: async () => ({ exitCode: 0, stdout: "", stderr: "", output: "", aborted: false }),
        }),
      ).rejects.toThrow(PathSafetyError);
    } finally {
      rmSync(box, { recursive: true, force: true });
    }
  });

  test("rejects a flag-like value in a free-form string field (argv-injection guard)", async () => {
    const box = newBox();
    try {
      await expect(
        runPyVideo({
          options: { action: "--evil-flag" },
          outputDir: box,
          _spawnImpl: async () => ({ exitCode: 0, stdout: "", stderr: "", output: "", aborted: false }),
        }),
      ).rejects.toThrow(PathSafetyError);
    } finally {
      rmSync(box, { recursive: true, force: true });
    }
  });

  // Machine-coupled: asserts the local MLX venv + run.py are present on disk.
  // GitHub Actions runners have neither (no Apple-Silicon Metal, no venv), so
  // this skips under CI=true. See .github/CI.md.
  // Skip (not fail) whenever the venv is absent — CI AND a local machine
  // right after `git clean -dxf` / fresh clone (before setup-offline.sh).
  const VENV_PRESENT = existsSync(resolveRunPyPaths(resolveRepoRoot()).python);
  test.skipIf(Boolean(process.env.CI) || !VENV_PRESENT)("resolves venv python + run.py from the repo root (paths exist on this machine)", () => {
    const { python, runPy } = resolveRunPyPaths(resolveRepoRoot());
    expect(existsSync(python)).toBe(true);
    expect(existsSync(runPy)).toBe(true);
    expect(python).toContain("python/venv/bin/python");
    expect(runPy).toContain("run.py");
  });
});
