import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertPathAllowed,
  PathSafetyError,
  rejectFlagLike,
  resolveModelsRoot,
  resolveOutputDir,
  validateExtraArgs,
} from "./paths.ts";

function makeRoots() {
  const base = mkdtempSync(join(tmpdir(), "pi-flux2-paths-"));
  const repoRoot = join(base, "repo");
  const outputDir = join(base, "output");
  const modelsRoot = join(base, "models");
  for (const d of [repoRoot, outputDir, modelsRoot]) mkdirSync(d, { recursive: true });
  const outsideDir = join(base, "outside");
  mkdirSync(outsideDir, { recursive: true });
  return { base, repoRoot, outputDir, modelsRoot, outsideDir };
}

describe("assertPathAllowed", () => {
  test("accepts a path under repoRoot", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    const f = join(repoRoot, "photo.png");
    writeFileSync(f, "x");
    const resolved = assertPathAllowed(f, { repoRoot, outputDir, modelsRoot }, { mustExist: true });
    expect(resolved).toBe(f);
  });

  test("rejects a path outside every allowed root", () => {
    const { repoRoot, outputDir, modelsRoot, outsideDir } = makeRoots();
    const f = join(outsideDir, "photo.png");
    writeFileSync(f, "x");
    expect(() => assertPathAllowed(f, { repoRoot, outputDir, modelsRoot })).toThrow(PathSafetyError);
  });

  test("rejects a leading-dash value before it ever resolves a path", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    expect(() => assertPathAllowed("--output-dir", { repoRoot, outputDir, modelsRoot })).toThrow(
      PathSafetyError,
    );
  });

  test("rejects an empty value", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    expect(() => assertPathAllowed("", { repoRoot, outputDir, modelsRoot })).toThrow(PathSafetyError);
  });

  test("mustExist=true rejects a non-existent path under an allowed root", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    const f = join(repoRoot, "does-not-exist.png");
    expect(() => assertPathAllowed(f, { repoRoot, outputDir, modelsRoot }, { mustExist: true })).toThrow(
      PathSafetyError,
    );
  });

  test("mustExist=false allows a not-yet-created output path under an allowed root", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    const f = join(outputDir, "new-output.png");
    const resolved = assertPathAllowed(f, { repoRoot, outputDir, modelsRoot }, { mustExist: false });
    expect(resolved).toBe(f);
  });

  test("a path directly at an allowed root's boundary is accepted (no substring escape)", () => {
    // roots.repoRoot = "/x/repo"; sibling "/x/repo-evil" must NOT be treated as "under" repoRoot.
    const { base, outputDir, modelsRoot } = makeRoots();
    const repoRoot = join(base, "repo");
    const sibling = join(base, "repo-evil");
    mkdirSync(sibling, { recursive: true });
    const f = join(sibling, "photo.png");
    writeFileSync(f, "x");
    expect(() => assertPathAllowed(f, { repoRoot, outputDir, modelsRoot })).toThrow(PathSafetyError);
  });
});

describe("rejectFlagLike", () => {
  test("throws on a leading-dash string", () => {
    expect(() => rejectFlagLike("-rf", "prompt")).toThrow(PathSafetyError);
  });
  test("passes through a normal string", () => {
    expect(() => rejectFlagLike("a normal prompt", "prompt")).not.toThrow();
  });
  test("ignores non-string values", () => {
    expect(() => rejectFlagLike(42 as unknown as string, "seed")).not.toThrow();
  });
});

describe("validateExtraArgs", () => {
  test("allows an allow-listed flag token", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    const out = validateExtraArgs(["--strict-gate"], { repoRoot, outputDir, modelsRoot }, ["strict-gate"]);
    expect(out).toEqual(["--strict-gate"]);
  });

  test("rejects a flag token that is not allow-listed", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    expect(() =>
      validateExtraArgs(["--models-root=/etc"], { repoRoot, outputDir, modelsRoot }, ["strict-gate"]),
    ).toThrow(PathSafetyError);
  });

  test("path-validates a pathy value token against the allowed roots", () => {
    const { repoRoot, outputDir, modelsRoot, outsideDir } = makeRoots();
    const f = join(outsideDir, "sneaky.png");
    writeFileSync(f, "x");
    expect(() =>
      validateExtraArgs([f], { repoRoot, outputDir, modelsRoot }, []),
    ).toThrow(PathSafetyError);
  });

  test("allows a non-pathy scalar value token (e.g. a preset name)", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    const out = validateExtraArgs(["all"], { repoRoot, outputDir, modelsRoot }, []);
    expect(out).toEqual(["all"]);
  });

  test("rejects a scalar value token that is itself flag-like", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    expect(() => validateExtraArgs(["-x"], { repoRoot, outputDir, modelsRoot }, [])).toThrow(
      PathSafetyError,
    );
  });

  test("skips empty tokens", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    const out = validateExtraArgs([""], { repoRoot, outputDir, modelsRoot }, []);
    expect(out).toEqual([]);
  });
});

describe("resolveOutputDir", () => {
  test("uses the override when provided (relative resolves against repoRoot)", () => {
    const repoRoot = "/repo";
    expect(resolveOutputDir(repoRoot, "custom-out")).toBe(join(repoRoot, "custom-out"));
  });

  test("uses an absolute override as-is", () => {
    const repoRoot = "/repo";
    expect(resolveOutputDir(repoRoot, "/abs/out")).toBe("/abs/out");
  });

  test("falls back to ../video_generation__output when no override/env", () => {
    const savedEnv = process.env.MLX_OUTPUT_DIR;
    delete process.env.MLX_OUTPUT_DIR;
    try {
      const repoRoot = "/repo";
      expect(resolveOutputDir(repoRoot)).toBe(join(repoRoot, "..", "video_generation__output"));
    } finally {
      if (savedEnv !== undefined) process.env.MLX_OUTPUT_DIR = savedEnv;
    }
  });
});

describe("resolveModelsRoot", () => {
  test("uses the override when provided", () => {
    const repoRoot = "/repo";
    expect(resolveModelsRoot(repoRoot, "custom-models")).toBe(join(repoRoot, "custom-models"));
  });

  test("defaults to <repoRoot>/mlx-models (post model-root migration)", () => {
    const savedEnv = process.env.MLX_MODELS_DIR;
    delete process.env.MLX_MODELS_DIR;
    try {
      const repoRoot = "/repo";
      expect(resolveModelsRoot(repoRoot)).toBe(join(repoRoot, "mlx-models"));
    } finally {
      if (savedEnv !== undefined) process.env.MLX_MODELS_DIR = savedEnv;
    }
  });
});
