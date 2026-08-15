/**
 * ensure-workspace-dist — unit tests.
 *
 * Two layers, mirroring the ensure-model-tiers.test.ts split (pure helper vs
 * import-time wrapper):
 *   1. Pure detection + decision helpers from ../workspace-dist-staleness.ts,
 *      tested against tmp-dir fixtures.
 *   2. The heal wrapper loop (healStaleWorkspaceDists) driven through the
 *      injectable BuildSpawn seam against a fake bun-apps/ workspace — the
 *      loop's discovery rules and every error path are covered WITHOUT running
 *      `bun run build` against anything real.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  distEntryMain,
  newestMtimeMs,
  shouldRebuildDist,
} from "../workspace-dist-staleness.ts";
import { __test, type BuildSpawn } from "./ensure-workspace-dist.ts";

const TMP = join(tmpdir(), `ws-dist-staleness-${process.pid}`);
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

/** Build a fake package dir: package.json + src files + (optional) dist files.
 * `srcMs`/`distMs` set explicit mtimes so tests don't depend on write order. */
function fixture(opts: {
  main: string;
  srcFiles?: string[];
  distFiles?: string[];
  srcMs?: number;
  distMs?: number;
}): string {
  const pkgDir = join(TMP, `pkg-${Math.random().toString(36).slice(2)}`);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@repo/x", main: opts.main, type: "module" }));
  for (const f of opts.srcFiles ?? []) {
    mkdirSync(join(pkgDir, "src"), { recursive: true });
    writeFileSync(join(pkgDir, "src", f), "export {};\n");
    // utimesSync numbers are SECONDS — pass Dates so the *_Ms fixtures stay in ms.
    if (opts.srcMs !== undefined) utimesSync(join(pkgDir, "src", f), new Date(opts.srcMs), new Date(opts.srcMs));
  }
  for (const f of opts.distFiles ?? []) {
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    writeFileSync(join(pkgDir, "dist", f), "export {};\n");
    if (opts.distMs !== undefined) utimesSync(join(pkgDir, "dist", f), new Date(opts.distMs), new Date(opts.distMs));
  }
  return pkgDir;
}

describe("distEntryMain — which packages have a dist build entry", () => {
  test("main './dist/index.js' → './dist/index.js'", () => {
    expect(distEntryMain({ main: "./dist/index.js" })).toBe("./dist/index.js");
  });

  test("src entry ('./src/index.ts') → null (not dist-built)", () => {
    expect(distEntryMain({ main: "./src/index.ts" })).toBeNull();
  });

  test("missing main → null", () => {
    expect(distEntryMain({})).toBeNull();
  });

  test("exports map import './dist/index.js' wins when main is absent", () => {
    const pkg = { exports: { ".": { import: "./dist/index.js" } } } as Record<string, unknown>;
    expect(distEntryMain(pkg)).toBe("./dist/index.js");
  });

  test("exports map with src import → null", () => {
    const pkg = { exports: { ".": { import: "./src/index.ts" } } } as Record<string, unknown>;
    expect(distEntryMain(pkg)).toBeNull();
  });
});

describe("shouldRebuildDist — staleness decision", () => {
  const T0 = 1_700_000_000_000;

  test("fresh dist (newest src older than newest dist) → NO rebuild", () => {
    expect(shouldRebuildDist({ newestSrcMs: T0, newestDistMs: T0 + 1000 })).toBe(false);
  });

  test("stale dist (src newer than dist) → rebuild (the incident shape)", () => {
    expect(shouldRebuildDist({ newestSrcMs: T0 + 1000, newestDistMs: T0 })).toBe(true);
  });

  test("missing dist → rebuild", () => {
    expect(shouldRebuildDist({ newestSrcMs: T0, newestDistMs: null })).toBe(true);
  });

  test("no src → NO rebuild (nothing to compile)", () => {
    expect(shouldRebuildDist({ newestSrcMs: null, newestDistMs: T0 })).toBe(false);
  });

  test("no src and no dist → NO rebuild", () => {
    expect(shouldRebuildDist({ newestSrcMs: null, newestDistMs: null })).toBe(false);
  });
});

describe("newestMtimeMs — recursive walk (fixture end-to-end)", () => {
  const T0 = 1_700_000_000_000;

  test("stale fixture: src touched after dist → dist stale", () => {
    const dir = fixture({
      main: "./dist/index.js",
      srcFiles: ["index.ts"],
      distFiles: ["index.js"],
      srcMs: T0 + 5000,
      distMs: T0,
    });
    const newestSrc = newestMtimeMs(join(dir, "src"));
    const newestDist = newestMtimeMs(join(dir, "dist"));
    expect(shouldRebuildDist({ newestSrcMs: newestSrc, newestDistMs: newestDist })).toBe(true);
  });

  test("fresh fixture: dist newer than src → not stale", () => {
    const dir = fixture({
      main: "./dist/index.js",
      srcFiles: ["index.ts"],
      distFiles: ["index.js"],
      srcMs: T0,
      distMs: T0 + 5000,
    });
    const newestSrc = newestMtimeMs(join(dir, "src"));
    const newestDist = newestMtimeMs(join(dir, "dist"));
    expect(shouldRebuildDist({ newestSrcMs: newestSrc, newestDistMs: newestDist })).toBe(false);
  });

  test("missing dir → null", () => {
    expect(newestMtimeMs(join(TMP, "no-such-dir"))).toBeNull();
  });

  test("nested dirs are walked", () => {
    const dir = fixture({
      main: "./dist/index.js",
      srcFiles: ["index.ts"],
      distFiles: ["index.js"],
      srcMs: T0,
      distMs: T0,
    });
    // add a nested src file with a NEWER mtime — must be picked up
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    const nested = join(dir, "src", "lib", "deep.ts");
    writeFileSync(nested, "export {};\n");
    utimesSync(nested, new Date(T0 + 9000), new Date(T0 + 9000));
    const newestSrc = newestMtimeMs(join(dir, "src"));
    const newestDist = newestMtimeMs(join(dir, "dist"));
    expect(shouldRebuildDist({ newestSrcMs: newestSrc, newestDistMs: newestDist })).toBe(true);
  });
});

describe("healStaleWorkspaceDists — wrapper loop (injectable BuildSpawn)", () => {
  const T0 = 1_750_000_000_000;

  /** Fake bun-apps/ dir: one sub-dir per package spec. */
  function wsFixture(
    pkgs: Array<{
      dir: string;
      name?: string | null; // null → malformed package.json
      main?: string;
      srcFiles?: string[];
      distFiles?: string[];
      srcMs?: number;
      distMs?: number;
      noSrcDir?: boolean;
    }>,
  ): string {
    const appsDir = join(TMP, `apps-${Math.random().toString(36).slice(2)}`);
    for (const p of pkgs) {
      const pkgDir = join(appsDir, p.dir);
      mkdirSync(pkgDir, { recursive: true });
      if (p.name === null) {
        writeFileSync(join(pkgDir, "package.json"), "{ not json");
      } else {
        writeFileSync(
          join(pkgDir, "package.json"),
          JSON.stringify({ name: p.name ?? `@repo/${p.dir}`, main: p.main ?? "./dist/index.js", type: "module" }),
        );
      }
      if (!p.noSrcDir) {
        for (const f of p.srcFiles ?? []) {
          mkdirSync(join(pkgDir, "src"), { recursive: true });
          const file = join(pkgDir, "src", f);
          writeFileSync(file, "export {};\n");
          if (p.srcMs !== undefined) utimesSync(file, new Date(p.srcMs), new Date(p.srcMs));
        }
      }
      for (const f of p.distFiles ?? []) {
        mkdirSync(join(pkgDir, "dist"), { recursive: true });
        const file = join(pkgDir, "dist", f);
        writeFileSync(file, "export {};\n");
        if (p.distMs !== undefined) utimesSync(file, new Date(p.distMs), new Date(p.distMs));
      }
    }
    return appsDir;
  }

  /** Capture console.error lines while fn runs. */
  function captureStderr(fn: () => void): string[] {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      fn();
    } finally {
      console.error = orig;
    }
    return lines;
  }

  /** Build-spawn stub: records each cwd; `heal` writes a fresh dist when run. */
  function stubSpawn(opts: { heal?: boolean; status?: number; throwMsg?: string } = {}) {
    const calls: string[] = [];
    const spawn: BuildSpawn = (cwd) => {
      calls.push(cwd);
      if (opts.throwMsg) throw new Error(opts.throwMsg);
      if (opts.heal) {
        // Simulate a real `bun run build`: write a dist file newer than any src.
        const distDir = join(cwd, "dist");
        mkdirSync(distDir, { recursive: true });
        const file = join(distDir, "index.js");
        writeFileSync(file, "export {};\n");
        utimesSync(file, new Date(T0 + 60_000), new Date(T0 + 60_000));
      }
      return { status: opts.status ?? 0, stdout: "", stderr: "boom" };
    };
    return { calls, spawn };
  }

  test("stale dist → heal runs in the package dir and reports rebuilt OK", () => {
    const apps = wsFixture([{ dir: "pkg-a", srcFiles: ["index.ts"], distFiles: ["index.js"], srcMs: T0 + 5000, distMs: T0 }]);
    const { calls, spawn } = stubSpawn({ heal: true });
    const err = captureStderr(() => __test.healStaleWorkspaceDists(apps, spawn));
    expect(calls).toEqual([join(apps, "pkg-a")]);
    expect(err.some((l) => l.includes("@repo/pkg-a") && l.includes("dist rebuilt OK"))).toBe(true);
  });

  test("fresh dist → no spawn, silent", () => {
    const apps = wsFixture([{ dir: "pkg-a", srcFiles: ["index.ts"], distFiles: ["index.js"], srcMs: T0, distMs: T0 + 5000 }]);
    const { calls, spawn } = stubSpawn();
    const err = captureStderr(() => __test.healStaleWorkspaceDists(apps, spawn));
    expect(calls).toEqual([]);
    expect(err).toEqual([]);
  });

  test("missing dist (src only) → counts as stale, heal runs", () => {
    const apps = wsFixture([{ dir: "pkg-a", srcFiles: ["index.ts"], srcMs: T0 }]);
    const { calls, spawn } = stubSpawn({ heal: true });
    const err = captureStderr(() => __test.healStaleWorkspaceDists(apps, spawn));
    expect(calls.length).toBe(1);
    expect(err.some((l) => l.includes("dist/ is stale"))).toBe(true);
  });

  test("build exits nonzero → warns with status + stderr tail, never throws", () => {
    const apps = wsFixture([{ dir: "pkg-a", srcFiles: ["index.ts"], distFiles: ["index.js"], srcMs: T0 + 5000, distMs: T0 }]);
    const { calls, spawn } = stubSpawn({ status: 1 });
    const err = captureStderr(() => __test.healStaleWorkspaceDists(apps, spawn));
    expect(calls.length).toBe(1);
    expect(err.some((l) => l.includes("rebuild FAILED (status 1)") && l.includes("boom"))).toBe(true);
  });

  test("build exits 0 but dist still stale → DISTINCT still-stale message, not FAILED", () => {
    const apps = wsFixture([{ dir: "pkg-a", srcFiles: ["index.ts"], distFiles: ["index.js"], srcMs: T0 + 5000, distMs: T0 }]);
    const { spawn } = stubSpawn({ status: 0 }); // heal: false — writes nothing
    const err = captureStderr(() => __test.healStaleWorkspaceDists(apps, spawn));
    expect(err.some((l) => l.includes("STILL stale"))).toBe(true);
    expect(err.some((l) => l.includes("FAILED"))).toBe(false);
  });

  test("spawn throws → caught, warns 'spawn failed', never throws", () => {
    const apps = wsFixture([{ dir: "pkg-a", srcFiles: ["index.ts"], distFiles: ["index.js"], srcMs: T0 + 5000, distMs: T0 }]);
    const { spawn } = stubSpawn({ throwMsg: "bun not found" });
    const err = captureStderr(() => __test.healStaleWorkspaceDists(apps, spawn));
    expect(err.some((l) => l.includes("rebuild spawn failed") && l.includes("bun not found"))).toBe(true);
  });

  test("skip rules: src-entry pkg, non-@repo pkg, malformed package.json, no-src-dir pkg, missing dir → no spawn, no throw", () => {
    const apps = wsFixture([
      { dir: "src-entry", main: "./src/index.ts", srcFiles: ["index.ts"], distFiles: ["index.js"], srcMs: T0 + 5000, distMs: T0 },
      { dir: "not-repo", name: "some-lib", srcFiles: ["index.ts"], distFiles: ["index.js"], srcMs: T0 + 5000, distMs: T0 },
      { dir: "broken-json", name: null, srcFiles: ["index.ts"], distFiles: ["index.js"], srcMs: T0 + 5000, distMs: T0 },
      { dir: "no-src", noSrcDir: true, distFiles: ["index.js"], distMs: T0 },
    ]);
    const { calls, spawn } = stubSpawn();
    const err = captureStderr(() => __test.healStaleWorkspaceDists(apps, spawn));
    expect(calls).toEqual([]);
    expect(err).toEqual([]);
    // nonexistent bun-apps dir → no throw either
    expect(() => __test.healStaleWorkspaceDists(join(TMP, "no-such-apps"), spawn)).not.toThrow();
  });

  test("multiple stale packages → each healed, in scan order", () => {
    const apps = wsFixture([
      { dir: "pkg-a", srcFiles: ["index.ts"], distFiles: ["index.js"], srcMs: T0 + 5000, distMs: T0 },
      { dir: "pkg-b", srcFiles: ["index.ts"], distFiles: ["index.js"], srcMs: T0 + 5000, distMs: T0 },
    ]);
    const { calls, spawn } = stubSpawn({ heal: true });
    const err = captureStderr(() => __test.healStaleWorkspaceDists(apps, spawn));
    expect(calls).toEqual([join(apps, "pkg-a"), join(apps, "pkg-b")]);
    expect(err.filter((l) => l.includes("rebuilt OK")).length).toBe(2);
  });
});
