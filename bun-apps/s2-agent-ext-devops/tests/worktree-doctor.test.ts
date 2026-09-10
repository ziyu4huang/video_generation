/**
 * worktree-doctor — MC-6: porcelain parsing + the prune flow, against an
 * injected spawn (hermetic; no real git).
 */
import { describe, expect, test } from "bun:test";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";
import { parseWorktreePorcelain, runWorktreeDoctorCli } from "../src/worktree-doctor-cli.ts";

const PORCELAIN = [
  "worktree /repo",
  `HEAD ${"a".repeat(40)}`,
  "branch refs/heads/main",
  "",
  "worktree /repo/.pi/worktrees/run-x",
  `HEAD ${"b".repeat(40)}`,
  "branch refs/heads/pi/wf/run-x",
  "",
  "worktree /private/tmp/dp-cb4",
  `HEAD ${"c".repeat(40)}`,
  "detached",
  "prunable git directory file: some reason",
  "",
].join("\n");

function mkSpawn(opts: { pruneRemovesAll?: boolean } = {}) {
  const calls: string[][] = [];
  const fn: SpawnFn = async (cmd, args) => {
    calls.push(args);
    if (args.includes("prune")) return { stdout: "", stderr: "", exitCode: 0 };
    if (args.includes("--porcelain")) {
      const text = opts.pruneRemovesAll
        ? `worktree /repo\nHEAD ${"a".repeat(40)}\nbranch refs/heads/main\n`
        : PORCELAIN;
      return { stdout: text, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { fn, calls };
}

describe("parseWorktreePorcelain", () => {
  test("parses path/head/branch/detached/prunable(+reason)", () => {
    const list = parseWorktreePorcelain(PORCELAIN);
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ path: "/repo", branch: "main" });
    expect(list[1]?.branch).toBe("pi/wf/run-x");
    expect(list[2]).toMatchObject({
      path: "/private/tmp/dp-cb4",
      detached: true,
      prunable: true,
      prunableReason: "git directory file: some reason",
    });
  });
});

describe("runWorktreeDoctorCli", () => {
  test("default: report only, prunable entries flagged, exit 0", async () => {
    const { fn } = mkSpawn();
    const res = await runWorktreeDoctorCli([], { spawn: fn, repoRoot: "/repo" });
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.pruned).toBe(false);
    expect(out.before.filter((w: { prunable?: boolean }) => w.prunable)).toHaveLength(1);
  });

  test("unknown argument → usage error, exit 2", async () => {
    const res = await runWorktreeDoctorCli(["--bogus"], { spawn: mkSpawn().fn, repoRoot: "/repo" });
    expect(res.exitCode).toBe(2);
  });

  test("git failure → exit 1 with the message", async () => {
    const fn: SpawnFn = async () => ({ stdout: "", stderr: "not a repo", exitCode: 128 });
    const res = await runWorktreeDoctorCli([], { spawn: fn, repoRoot: "/repo" });
    expect(res.exitCode).toBe(1);
  });
});
