import { describe, expect, it } from "bun:test";
import type { SpawnSyncReturns } from "node:child_process";
import { buildFreshnessWarning, checkFactFreshness } from "../src/freshness.js";

/**
 * Hermetic unit tests. checkFactFreshness takes an injectable spawnImpl, so we
 * feed it canned git responses instead of spawning a real `git` (a real spawn
 * would be a portability P2 host-binary probe — see .github/TEST-PORTABILITY.md).
 * The command-layer wiring (real git, local-only + CI-skipped) lives in
 * tests/commands.test.ts.
 */

/** Minimal git response — only `status` + `stdout` are read by freshness.ts. */
function resp(status: number, stdout = ""): SpawnSyncReturns<string> {
  return { pid: 0, output: [null, stdout, ""], stdout, stderr: "", status, signal: null };
}

/** A fake spawnImpl keyed on the git subcommand (args[0]); unmatched → failure. */
function fakeGit(table: Record<string, () => SpawnSyncReturns<string>>) {
  return (_cmd: string, args: readonly string[]): SpawnSyncReturns<string> => {
    const hit = table[args[0]];
    return hit ? hit() : resp(1);
  };
}

describe("checkFactFreshness", () => {
  it("reports behind count + base when HEAD lags origin/main", () => {
    const spawn = fakeGit({
      "symbolic-ref": () => resp(0, "origin/main\n"),
      "rev-parse": () => resp(0),
      "rev-list": () => resp(0, "3\n"),
    });
    expect(checkFactFreshness("/cwd", { spawnImpl: spawn })).toEqual({ behind: 3, base: "origin/main" });
  });

  it("reports behind 0 when HEAD is current with origin/main", () => {
    const spawn = fakeGit({
      "symbolic-ref": () => resp(0, "origin/main\n"),
      "rev-parse": () => resp(0),
      "rev-list": () => resp(0, "0\n"),
    });
    expect(checkFactFreshness("/cwd", { spawnImpl: spawn })).toEqual({ behind: 0, base: "origin/main" });
  });

  it("falls back to origin/main when origin/HEAD is unset but origin/main exists", () => {
    const spawn = fakeGit({
      "symbolic-ref": () => resp(1), // origin/HEAD unset
      "rev-parse": () => resp(0), // origin/main exists (fallback)
      "rev-list": () => resp(0, "0\n"),
    });
    expect(checkFactFreshness("/cwd", { spawnImpl: spawn })).toEqual({ behind: 0, base: "origin/main" });
  });

  it("returns null when there is no origin ref (graceful)", () => {
    const spawn = fakeGit({}); // every git call fails → resolveBase null
    expect(checkFactFreshness("/cwd", { spawnImpl: spawn })).toBeNull();
  });

  it("returns null when the base resolves but rev-list fails (graceful)", () => {
    const spawn = fakeGit({
      "symbolic-ref": () => resp(0, "origin/main\n"),
      "rev-parse": () => resp(0),
      "rev-list": () => resp(1),
    });
    expect(checkFactFreshness("/cwd", { spawnImpl: spawn })).toBeNull();
  });

  it("returns null when rev-list yields a non-numeric count (graceful)", () => {
    const spawn = fakeGit({
      "symbolic-ref": () => resp(0, "origin/main\n"),
      "rev-parse": () => resp(0),
      "rev-list": () => resp(0, "not-a-number\n"),
    });
    expect(checkFactFreshness("/cwd", { spawnImpl: spawn })).toBeNull();
  });

  it("returns null when spawn throws (git unavailable) — via injected spawn", () => {
    const throwing = (): SpawnSyncReturns<string> => {
      throw new Error("ENOENT");
    };
    expect(checkFactFreshness("/cwd", { spawnImpl: throwing })).toBeNull();
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
