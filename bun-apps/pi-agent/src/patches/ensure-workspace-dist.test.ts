/**
 * ensure-workspace-dist — unit tests for the pure helpers in
 * ../workspace-dist-staleness.ts.
 *
 * The import-time side effect (scanning bun-apps and rebuilding stale dists) is
 * intentionally NOT tested here; it would run `bun run build` against the live
 * workspace. We test the pure detection + decision helpers against tmp-dir
 * fixtures instead. Mirrors the ensure-model-tiers.test.ts split (pure helper
 * vs import-time wrapper).
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
