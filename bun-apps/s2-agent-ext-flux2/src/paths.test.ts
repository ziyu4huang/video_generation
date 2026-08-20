import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertModelsRootExists,
  assertPathAllowed,
  assertSafePathComponent,
  ensureOutputDir,
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

  test("rejects a symlink staged inside an allowed root whose target resolves outside every allowed root", () => {
    const { repoRoot, outputDir, modelsRoot, outsideDir } = makeRoots();
    const secret = join(outsideDir, "secret.png");
    writeFileSync(secret, "x");
    const link = join(outputDir, "evil-link.png");
    symlinkSync(secret, link);
    expect(() => assertPathAllowed(link, { repoRoot, outputDir, modelsRoot }, { mustExist: true })).toThrow(
      PathSafetyError,
    );
  });

  test("accepts a symlink inside an allowed root whose target also resolves inside an allowed root", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    const real = join(modelsRoot, "real.png");
    writeFileSync(real, "x");
    const link = join(outputDir, "good-link.png");
    symlinkSync(real, link);
    const resolved = assertPathAllowed(link, { repoRoot, outputDir, modelsRoot }, { mustExist: true });
    expect(resolved).toBe(link);
  });

  test("resolves consistently when a root itself lives under a symlinked ancestor (e.g. macOS /var -> /private/var)", () => {
    // Regression: comparing a realpath-resolved child against an UNRESOLVED
    // root (or vice versa) wrongly rejects every path once the fix required
    // the resolved path to be confined. tmpdir() on macOS is exactly this case.
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    const existing = join(repoRoot, "photo.png");
    writeFileSync(existing, "x");
    expect(() => assertPathAllowed(existing, { repoRoot, outputDir, modelsRoot }, { mustExist: true })).not.toThrow();
    const notYetCreated = join(outputDir, "brand-new.png");
    expect(() => assertPathAllowed(notYetCreated, { repoRoot, outputDir, modelsRoot }, { mustExist: false })).not.toThrow();
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

describe("assertSafePathComponent", () => {
  test("accepts a bare name", () => {
    expect(() => assertSafePathComponent("klein-9b", "transformer")).not.toThrow();
  });

  test("rejects a value containing a '..' segment", () => {
    expect(() => assertSafePathComponent("../../../../etc", "transformer")).toThrow(PathSafetyError);
  });

  test("rejects a bare '..'", () => {
    expect(() => assertSafePathComponent("..", "transformer")).toThrow(PathSafetyError);
  });

  test("rejects any value containing a path separator, even without '..'", () => {
    expect(() => assertSafePathComponent("sub/dir", "transformer")).toThrow(PathSafetyError);
    expect(() => assertSafePathComponent("sub\\dir", "transformer")).toThrow(PathSafetyError);
  });

  test("rejects an absolute path", () => {
    expect(() => assertSafePathComponent("/etc/passwd", "transformer")).toThrow(PathSafetyError);
  });

  test("rejects a leading-dash value (flag injection)", () => {
    expect(() => assertSafePathComponent("--models-root", "transformer")).toThrow(PathSafetyError);
  });

  test("rejects an empty value", () => {
    expect(() => assertSafePathComponent("", "transformer")).toThrow(PathSafetyError);
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

  test("rejects a short relative-traversal token ('..') as the value of an allow-listed path flag", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    // ".." has no "/" and is too short for the old length>4 heuristic — it must
    // still be path-validated (and rejected, since it resolves outside every root).
    expect(() =>
      validateExtraArgs(["--output", ".."], { repoRoot, outputDir, modelsRoot }, ["output"]),
    ).toThrow(PathSafetyError);
  });

  test("rejects a bare '.' traversal token the same way", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    // "." resolves to repoRoot itself here, which IS allowed — assert it goes
    // through assertPathAllowed (i.e. doesn't silently skip as a scalar) by
    // checking it's accepted only because repoRoot is a valid root, not because
    // the heuristic exempted it.
    const out = validateExtraArgs(["--output", "."], { repoRoot, outputDir, modelsRoot }, ["output"]);
    expect(out).toEqual(["--output", "."]);
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

describe("ensureOutputDir", () => {
  test("creates a missing output dir (recursive) and returns the resolved path", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-flux2-out-"));
    const target = join(dir, "nested", "out");
    expect(existsSync(target)).toBe(false);
    // absolute override → ensureOutputDir resolves to it and creates it
    expect(ensureOutputDir(dir, target)).toBe(target);
    expect(existsSync(target)).toBe(true);
    // idempotent: calling again on an existing dir is a no-op
    expect(() => ensureOutputDir(dir, target)).not.toThrow();
  });

  test("REGRESSION: after ensureOutputDir creates a fresh dir under a symlinked ancestor (macOS /tmp -> /private/tmp), a not-yet-created --output under it validates cleanly", () => {
    // Bug: index.ts used to validate paths BEFORE ensureOutputDir. When the
    // outputDir didn't exist yet, realOrSelf(root) fell back to the unresolved
    // path while realpathOfNearestExisting(child) walked up to /private/tmp —
    // mismatching and wrongly rejecting a legitimate --output. ensureOutputDir
    // MUST run first (it does in index.ts runOnce). This test locks the
    // path-layer invariant the ordering relies on.
    const repoRoot = mkdtempSync(join(tmpdir(), "pi-flux2-order-repo-"));
    const freshOutputDir = join(repoRoot, "out", "fresh"); // does NOT exist yet (unique per run)
    expect(existsSync(freshOutputDir)).toBe(false);
    ensureOutputDir(repoRoot, freshOutputDir);
    expect(existsSync(freshOutputDir)).toBe(true);
    const futureOutput = join(freshOutputDir, "image.png"); // not created yet
    const roots = { repoRoot, outputDir: freshOutputDir, modelsRoot: join(repoRoot, "models") };
    expect(() => assertPathAllowed(futureOutput, roots, { kind: "output", mustExist: false })).not.toThrow();
  });
});

describe("assertModelsRootExists", () => {
  test("passes through when the dir exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-flux2-models-"));
    expect(assertModelsRootExists(dir, dir)).toBe(dir);
  });

  test("throws an actionable PathSafetyError naming MLX_MODELS_DIR when missing", () => {
    expect(() => assertModelsRootExists("/repo", "/repo/does-not-exist")).toThrow(
      /Models dir not found.*MLX_MODELS_DIR/s,
    );
  });
});
