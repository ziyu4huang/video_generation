import { afterEach, describe, expect, it } from "bun:test";
import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFreshnessWarning, checkFactFreshness } from "../src/freshness.js";

const roots: string[] = [];

/** Make a temp dir, run `setup` to initialize it, track it for cleanup. */
function makeDir(setup: (cwd: string) => void): string {
  const cwd = mkdtempSync(join(tmpdir(), "wf-fresh-"));
  roots.push(cwd);
  setup(cwd);
  return cwd;
}

afterEach(() => {
  while (roots.length > 0) {
    const r = roots.pop();
    if (r) rmSync(r, { recursive: true, force: true });
  }
});

/** Run git in `cwd`; throw on failure so a broken fixture fails loud. */
function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/** Fixture: a repo where HEAD is exactly `behind` commits behind origin/main. */
function behindRepo(behind: number): string {
  return makeDir((cwd) => {
    git(cwd, "init", "-b", "main");
    git(cwd, "config", "user.email", "t@t");
    git(cwd, "config", "user.name", "t");
    git(cwd, "commit", "--allow-empty", "-m", "base");
    for (let i = 0; i < behind; i++) git(cwd, "commit", "--allow-empty", "-m", `ahead-${i}`);
    // main now sits `behind` commits ahead of "base".
    git(cwd, "checkout", "-b", "feature", `HEAD~${behind}`);
    git(cwd, "update-ref", "refs/remotes/origin/main", "refs/heads/main");
    git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  });
}

describe("checkFactFreshness", () => {
  it("reports the behind count + base when HEAD lags origin/main", () => {
    const f = checkFactFreshness(behindRepo(3));
    expect(f).not.toBeNull();
    expect(f?.behind).toBe(3);
    expect(f?.base).toBe("origin/main");
  });

  it("reports behind 0 when HEAD is current with origin/main", () => {
    const f = checkFactFreshness(behindRepo(0));
    expect(f?.behind).toBe(0);
    expect(f?.base).toBe("origin/main");
  });

  it("falls back to origin/main when origin/HEAD is unset but origin/main exists", () => {
    const cwd = makeDir((c) => {
      git(c, "init", "-b", "main");
      git(c, "config", "user.email", "t@t");
      git(c, "config", "user.name", "t");
      git(c, "commit", "--allow-empty", "-m", "x");
      git(c, "update-ref", "refs/remotes/origin/main", "refs/heads/main");
      // deliberately no symbolic-ref for refs/remotes/origin/HEAD
    });
    const f = checkFactFreshness(cwd);
    expect(f?.base).toBe("origin/main");
    expect(f?.behind).toBe(0);
  });

  it("returns null when there is no origin ref (graceful)", () => {
    const cwd = makeDir((c) => {
      git(c, "init", "-b", "main");
      git(c, "config", "user.email", "t@t");
      git(c, "config", "user.name", "t");
      git(c, "commit", "--allow-empty", "-m", "x");
    });
    expect(checkFactFreshness(cwd)).toBeNull();
  });

  it("returns null in a non-git directory (graceful)", () => {
    expect(checkFactFreshness(makeDir(() => {}))).toBeNull();
  });

  it("returns null when spawn throws (git unavailable) — via injected spawn", () => {
    const failing = (): SpawnSyncReturns<string> => {
      throw new Error("ENOENT");
    };
    expect(checkFactFreshness(behindRepo(1), { spawnImpl: failing })).toBeNull();
  });
});

describe("buildFreshnessWarning", () => {
  it("returns null when current (behind 0)", () => {
    expect(buildFreshnessWarning({ behind: 0, base: "origin/main" })).toBeNull();
  });

  it("returns null when the check itself was null", () => {
    expect(buildFreshnessWarning(null)).toBeNull();
  });

  it("returns a warning naming the count and base when behind", () => {
    const w = buildFreshnessWarning({ behind: 5, base: "origin/main" });
    expect(w).not.toBeNull();
    expect(w).toContain("5");
    expect(w).toContain("origin/main");
    expect(w?.toLowerCase()).toContain("behind");
  });

  it("uses singular 'commit' when behind 1", () => {
    const w = buildFreshnessWarning({ behind: 1, base: "origin/main" });
    expect(w).toContain("1 commit ");
    expect(w).not.toContain("1 commits");
  });
});
