import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compareVersions } from "../scripts/update-superpowers.ts";

/**
 * Golden end-to-end coverage for the update-superpowers script (the bun twin
 * of the retired update-superpowers.sh): it syncs skills/ from a plugin cache
 * version dir, picking the newest version via `sort -V` emulation when no
 * version is given. Hermetic by construction — the script under test is COPIED
 * into a tmp package layout and the cache is a crafted tmp fixture; neither the
 * real package dir nor a real $CLAUDE_PLUGINS_CACHE is ever touched.
 */
const PKG = resolve(import.meta.dir, "..");
const SCRIPT_SRC = join(PKG, "scripts");

function runScript(
  pkg: string,
  cache: string,
  versionArg?: string,
): { stdout: string; stderr: string; status: number | null } {
  const args = [join(pkg, "scripts/update-superpowers.ts"), ...(versionArg !== undefined ? [versionArg] : [])];
  const r = spawnSync(process.execPath, args, {
    cwd: pkg,
    env: { ...process.env, CLAUDE_PLUGINS_CACHE: cache },
  });
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), status: r.status };
}

/** Recursive tree fingerprint: sorted `relpath:content` lines (dirs omitted). */
function treeSnapshot(dir: string): string {
  if (!existsSync(dir)) return "<missing>";
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${p.slice(dir.length + 1)}:${readFileSync(p, "utf8")}`);
    }
  };
  walk(dir);
  return out.sort().join("\n");
}

/** Crafted cache: v1.0.0 / v1.2.0 / v2.0.0 with distinguishable skills fixtures. */
function makeCache(dir: string): void {
  mkdirSync(join(dir, "1.0.0/skills"), { recursive: true });
  writeFileSync(join(dir, "1.0.0/skills/legacy.md"), "one");
  mkdirSync(join(dir, "1.2.0/skills"), { recursive: true });
  writeFileSync(join(dir, "1.2.0/skills/mid.md"), "two");
  mkdirSync(join(dir, "2.0.0/skills"), { recursive: true });
  writeFileSync(join(dir, "2.0.0/skills/current.md"), "three");
  writeFileSync(join(dir, "2.0.0/skills/current.txt"), "four");
}

/** Tmp package copy (scripts/ + a stale skills/ that must be replaced). */
function makePkg(dir: string): void {
  cpSync(SCRIPT_SRC, join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(join(dir, "skills/stale.md"), "stale");
}

function withTmp(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "upd-sp-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("update-superpowers.ts", () => {
  it("syncs skills/ from the newest cache version when no version is given", () => {
    withTmp((root) => {
      const cache = join(root, "cache");
      const pkg = join(root, "pkg");
      makeCache(cache);
      makePkg(pkg);
      const r = runScript(pkg, cache);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
      expect(treeSnapshot(join(pkg, "skills"))).toBe(treeSnapshot(join(cache, "2.0.0/skills")));
      expect(r.stdout).toBe(
        `▶ sync skills/ from ${cache}/2.0.0\n\ndone. review the diff:  git diff bun-apps/s2-agent-ext-superpowers/skills/\n`,
      );
    });
  });

  it("syncs skills/ from an explicitly requested [version]", () => {
    withTmp((root) => {
      const cache = join(root, "cache");
      const pkg = join(root, "pkg");
      makeCache(cache);
      makePkg(pkg);
      const r = runScript(pkg, cache, "1.0.0");
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
      expect(treeSnapshot(join(pkg, "skills"))).toBe(treeSnapshot(join(cache, "1.0.0/skills")));
      expect(r.stdout).toBe(
        `▶ sync skills/ from ${cache}/1.0.0\n\ndone. review the diff:  git diff bun-apps/s2-agent-ext-superpowers/skills/\n`,
      );
    });
  });

  it("exits 1 and prints an error when the cache is missing", () => {
    withTmp((root) => {
      const cache = join(root, "missing-cache");
      const pkg = join(root, "pkg");
      makePkg(pkg);
      const r = runScript(pkg, cache);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(`error: no superpowers plugin cache at ${cache}\n`);
    });
  });

  it("exits 1 and does not touch skills/ when the requested version has no skills/ dir", () => {
    withTmp((root) => {
      const cache = join(root, "cache");
      const pkg = join(root, "pkg");
      makeCache(cache);
      makePkg(pkg);
      const before = treeSnapshot(join(pkg, "skills"));
      const r = runScript(pkg, cache, "9.9.9");
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe(`error: ${cache}/9.9.9/skills not found\n`);
      expect(treeSnapshot(join(pkg, "skills"))).toBe(before);
    });
  });

  it("compareVersions() replicates sort -V order on version-shaped names", () => {
    // Order provable against /usr/bin/sort -V (verified on this machine) for
    // the picked cache names plus suffix-shaped names the cache could produce.
    const sorted = [
      "1.0.0",
      "1.0.0rc",
      "1.0.0+meta",
      "1.0.0-alpha",
      "1.0.0-rc.1",
      "1.0.0.0",
      "1.2.0",
      "1.10.0",
      "2.0.0",
      "2.0.1-rc.1",
    ];
    const copy = [...sorted];
    copy.sort(compareVersions);
    expect(copy).toEqual(sorted);
    expect(compareVersions("2.0.1-rc.1", "2.0.0")).toBeGreaterThan(0);
  });
});
