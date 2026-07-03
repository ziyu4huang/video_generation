import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
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
  const base = mkdtempSync(join(tmpdir(), "pi-krea2-paths-"));
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
    expect(assertPathAllowed(f, { repoRoot, outputDir, modelsRoot }, { mustExist: true })).toBe(f);
  });

  test("rejects a path outside every allowed root", () => {
    const { repoRoot, outputDir, modelsRoot, outsideDir } = makeRoots();
    const f = join(outsideDir, "photo.png");
    writeFileSync(f, "x");
    expect(() => assertPathAllowed(f, { repoRoot, outputDir, modelsRoot })).toThrow(PathSafetyError);
  });

  test("rejects a leading-dash value before it ever resolves a path", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    expect(() => assertPathAllowed("--out", { repoRoot, outputDir, modelsRoot })).toThrow(PathSafetyError);
  });

  test("rejects an empty value", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    expect(() => assertPathAllowed("", { repoRoot, outputDir, modelsRoot })).toThrow(PathSafetyError);
  });

  test("mustExist=true rejects a non-existent path under an allowed root", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    expect(() =>
      assertPathAllowed(join(repoRoot, "does-not-exist.png"), { repoRoot, outputDir, modelsRoot }, { mustExist: true }),
    ).toThrow(PathSafetyError);
  });

  test("mustExist=false allows a not-yet-created output path under an allowed root", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    const f = join(outputDir, "new-output.png");
    expect(assertPathAllowed(f, { repoRoot, outputDir, modelsRoot }, { mustExist: false })).toBe(f);
  });

  test("a sibling that shares a name prefix with repoRoot is NOT treated as under it", () => {
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
    expect(assertPathAllowed(link, { repoRoot, outputDir, modelsRoot }, { mustExist: true })).toBe(link);
  });

  test("resolves consistently when a root itself lives under a symlinked ancestor (macOS /var -> /private/var)", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    const existing = join(repoRoot, "photo.png");
    writeFileSync(existing, "x");
    expect(() =>
      assertPathAllowed(existing, { repoRoot, outputDir, modelsRoot }, { mustExist: true }),
    ).not.toThrow();
    const notYetCreated = join(outputDir, "brand-new.png");
    expect(() =>
      assertPathAllowed(notYetCreated, { repoRoot, outputDir, modelsRoot }, { mustExist: false }),
    ).not.toThrow();
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
    expect(() => assertSafePathComponent("krea2-turbo", "transformer")).not.toThrow();
  });
  test("rejects a value containing a '..' segment", () => {
    expect(() => assertSafePathComponent("../../../../etc", "transformer")).toThrow(PathSafetyError);
  });
  test("rejects a bare '..'", () => {
    expect(() => assertSafePathComponent("..", "transformer")).toThrow(PathSafetyError);
  });
  test("rejects any value containing a path separator", () => {
    expect(() => assertSafePathComponent("sub/dir", "transformer")).toThrow(PathSafetyError);
    expect(() => assertSafePathComponent("sub\\dir", "transformer")).toThrow(PathSafetyError);
  });
  test("rejects an absolute path", () => {
    expect(() => assertSafePathComponent("/etc/passwd", "transformer")).toThrow(PathSafetyError);
  });
  test("rejects a leading-dash value", () => {
    expect(() => assertSafePathComponent("--out", "transformer")).toThrow(PathSafetyError);
  });
  test("rejects an empty value", () => {
    expect(() => assertSafePathComponent("", "transformer")).toThrow(PathSafetyError);
  });
});

describe("validateExtraArgs", () => {
  test("allows an allow-listed flag token", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    expect(validateExtraArgs(["--bridge"], { repoRoot, outputDir, modelsRoot }, ["bridge"])).toEqual(["--bridge"]);
  });
  test("rejects a flag token that is not allow-listed", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    expect(() =>
      validateExtraArgs(["--evil=/etc"], { repoRoot, outputDir, modelsRoot }, ["bridge"]),
    ).toThrow(PathSafetyError);
  });
  test("path-validates a pathy value token against the allowed roots", () => {
    const { repoRoot, outputDir, modelsRoot, outsideDir } = makeRoots();
    const f = join(outsideDir, "sneaky.png");
    writeFileSync(f, "x");
    expect(() => validateExtraArgs([f], { repoRoot, outputDir, modelsRoot }, [])).toThrow(PathSafetyError);
  });
  test("allows a non-pathy scalar value token", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    expect(validateExtraArgs(["1.15"], { repoRoot, outputDir, modelsRoot }, [])).toEqual(["1.15"]);
  });
  test("rejects a scalar value token that is itself flag-like", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    expect(() => validateExtraArgs(["-x"], { repoRoot, outputDir, modelsRoot }, [])).toThrow(PathSafetyError);
  });
  test("rejects a short relative-traversal token ('..') as the value of an allow-listed flag", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    expect(() =>
      validateExtraArgs(["--out", ".."], { repoRoot, outputDir, modelsRoot }, ["out"]),
    ).toThrow(PathSafetyError);
  });
  test("skips empty tokens", () => {
    const { repoRoot, outputDir, modelsRoot } = makeRoots();
    expect(validateExtraArgs([""], { repoRoot, outputDir, modelsRoot }, [])).toEqual([]);
  });
});

describe("resolveOutputDir", () => {
  test("uses the override when provided (relative resolves against repoRoot)", () => {
    expect(resolveOutputDir("/repo", "custom-out")).toBe(join("/repo", "custom-out"));
  });
  test("uses an absolute override as-is", () => {
    expect(resolveOutputDir("/repo", "/abs/out")).toBe("/abs/out");
  });
  test("falls back to ../video_generation__output when no override/env", () => {
    const savedEnv = process.env.MLX_OUTPUT_DIR;
    delete process.env.MLX_OUTPUT_DIR;
    try {
      expect(resolveOutputDir("/repo")).toBe(join("/repo", "..", "video_generation__output"));
    } finally {
      if (savedEnv !== undefined) process.env.MLX_OUTPUT_DIR = savedEnv;
    }
  });
});

describe("resolveModelsRoot", () => {
  test("uses the override when provided", () => {
    expect(resolveModelsRoot("/repo", "custom-models")).toBe(join("/repo", "custom-models"));
  });
  test("defaults to <repoRoot>/mlx-models", () => {
    const savedEnv = process.env.MLX_MODELS_DIR;
    delete process.env.MLX_MODELS_DIR;
    try {
      expect(resolveModelsRoot("/repo")).toBe(join("/repo", "mlx-models"));
    } finally {
      if (savedEnv !== undefined) process.env.MLX_MODELS_DIR = savedEnv;
    }
  });
});

describe("ensureOutputDir", () => {
  test("creates a missing output dir (recursive) and returns the resolved path", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-krea2-out-"));
    const target = join(dir, "nested", "out");
    expect(existsSync(target)).toBe(false);
    expect(ensureOutputDir(dir, target)).toBe(target);
    expect(existsSync(target)).toBe(true);
    expect(() => ensureOutputDir(dir, target)).not.toThrow();
  });

  test("REGRESSION: after ensureOutputDir creates a fresh dir under a symlinked ancestor (macOS /tmp -> /private/tmp), a not-yet-created --out under it validates cleanly", () => {
    // Bug: index.ts used to validate paths BEFORE ensureOutputDir. When the
    // outputDir didn't exist yet, realOrSelf(root) fell back to the unresolved
    // path while realpathOfNearestExisting(child) walked up to /private/tmp —
    // mismatching and wrongly rejecting a legitimate --out. ensureOutputDir
    // MUST run first (it does in index.ts runKrea2). This test locks the
    // path-layer invariant the ordering relies on.
    const repoRoot = mkdtempSync(join(tmpdir(), "pi-krea2-order-repo-"));
    const freshOutputDir = join(repoRoot, "out", "fresh"); // does NOT exist yet (unique per run)
    expect(existsSync(freshOutputDir)).toBe(false);
    ensureOutputDir(repoRoot, freshOutputDir);
    expect(existsSync(freshOutputDir)).toBe(true);
    const futureOut = join(freshOutputDir, "image.png"); // not created yet
    const roots = { repoRoot, outputDir: freshOutputDir, modelsRoot: join(repoRoot, "models") };
    expect(() => assertPathAllowed(futureOut, roots, { kind: "out", mustExist: false })).not.toThrow();
  });
});
