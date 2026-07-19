import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanPack, inspectPack } from "../src/workflow-pack-clean.js";

/**
 * `workflow-pack-clean.ts` — inspect/clean/purge (decision 06, 3-tier safety).
 */
function makePack(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "cl-"));
  const packDir = join(root, ".pi", "workflows", "demo");
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(packDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return { root, packDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("inspectPack", () => {
  test("reports file counts across the three state dirs", () => {
    const p = makePack({ "intermediate/a.txt": "x", "intermediate/b.txt": "yy", "outputs/o.txt": "z" });
    const ins = inspectPack({ packDir: p.packDir, name: "demo", repoRoot: p.root });
    expect(ins.intermediate.files).toBe(2);
    expect(ins.outputs.files).toBe(1);
    expect(ins.runs.files).toBe(0);
    p.cleanup();
  });
});

describe("cleanPack", () => {
  test("default scope=intermediate executes without --yes and purges intermediates only", () => {
    const p = makePack({ "intermediate/a.txt": "x", "outputs/o.txt": "z" });
    const report = cleanPack({ packDir: p.packDir, name: "demo", repoRoot: p.root });
    expect(report.scope).toBe("intermediate");
    expect(report.dryRun).toBe(false);
    expect(report.removed).toBe(1);
    expect(existsSync(join(p.packDir, "intermediate", "a.txt"))).toBe(false);
    expect(existsSync(join(p.packDir, "outputs", "o.txt"))).toBe(true); // untouched
    p.cleanup();
  });

  test("scope=runs is dry-run by default (removed=0); yes:true executes", () => {
    const p = makePack({ "runs/r1.json": "{}" });
    const dry = cleanPack({ packDir: p.packDir, name: "demo", repoRoot: p.root, scope: "runs" });
    expect(dry.dryRun).toBe(true);
    expect(dry.removed).toBe(0);
    expect(readFileSync(join(p.packDir, "runs", "r1.json"), "utf8")).toBe("{}"); // still there

    const exec = cleanPack({ packDir: p.packDir, name: "demo", repoRoot: p.root, scope: "runs", yes: true });
    expect(exec.dryRun).toBe(false);
    expect(exec.removed).toBe(1);
    expect(existsSync(join(p.packDir, "runs", "r1.json"))).toBe(false);
    p.cleanup();
  });

  test("scope=outputs is also dry-run by default (lossy tier)", () => {
    const p = makePack({ "outputs/o.txt": "z" });
    const dry = cleanPack({ packDir: p.packDir, name: "demo", repoRoot: p.root, scope: "outputs" });
    expect(dry.dryRun).toBe(true);
    expect(dry.removed).toBe(0);
    p.cleanup();
  });

  // REGRESSION (2026-07 review): an explicit dry-run must always win — a caller
  // combining `--dry-run --yes` previously EXECUTED the deletion.
  test("explicit dryRun:true beats yes:true (nothing deleted)", () => {
    const p = makePack({ "runs/r1.json": "{}" });
    const report = cleanPack({
      packDir: p.packDir,
      name: "demo",
      repoRoot: p.root,
      scope: "runs",
      dryRun: true,
      yes: true,
    });
    expect(report.dryRun).toBe(true);
    expect(report.removed).toBe(0);
    expect(existsSync(join(p.packDir, "runs", "r1.json"))).toBe(true);
    p.cleanup();
  });

  // REGRESSION (2026-07 review): `keep` (last-N retention) was accepted in the
  // signature but never implemented — `keep: 2` deleted ALL runs.
  test("keep: N retains the N newest entries (by mtime) and deletes the rest", () => {
    const p = makePack({ "runs/old.json": "{}", "runs/mid.json": "{}", "runs/new.json": "{}" });
    // Stamp distinct mtimes: old < mid < new.
    const now = Date.now();
    const { utimesSync } = require("node:fs") as typeof import("node:fs");
    utimesSync(join(p.packDir, "runs", "old.json"), new Date(now - 30000), new Date(now - 30000));
    utimesSync(join(p.packDir, "runs", "mid.json"), new Date(now - 20000), new Date(now - 20000));
    utimesSync(join(p.packDir, "runs", "new.json"), new Date(now - 10000), new Date(now - 10000));

    const report = cleanPack({ packDir: p.packDir, name: "demo", repoRoot: p.root, scope: "runs", keep: 2, yes: true });
    expect(report.removed).toBe(1);
    expect(existsSync(join(p.packDir, "runs", "old.json"))).toBe(false);
    expect(existsSync(join(p.packDir, "runs", "mid.json"))).toBe(true);
    expect(existsSync(join(p.packDir, "runs", "new.json"))).toBe(true);
    p.cleanup();
  });

  test("keep larger than the entry count deletes nothing", () => {
    const p = makePack({ "runs/r1.json": "{}" });
    const report = cleanPack({ packDir: p.packDir, name: "demo", repoRoot: p.root, scope: "runs", keep: 5, yes: true });
    expect(report.removed).toBe(0);
    expect(existsSync(join(p.packDir, "runs", "r1.json"))).toBe(true);
    p.cleanup();
  });

  test("keep rejects a negative or non-integer value loudly", () => {
    const p = makePack({ "runs/r1.json": "{}" });
    expect(() =>
      cleanPack({ packDir: p.packDir, name: "demo", repoRoot: p.root, scope: "runs", keep: -1, yes: true }),
    ).toThrow(/--keep/);
    expect(() =>
      cleanPack({ packDir: p.packDir, name: "demo", repoRoot: p.root, scope: "runs", keep: 1.5, yes: true }),
    ).toThrow(/--keep/);
    p.cleanup();
  });
});
