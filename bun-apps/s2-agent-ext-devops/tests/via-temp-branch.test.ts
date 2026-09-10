/**
 * via-temp-branch — MC-3's guarded temp-copy rebase.
 *
 * The scenario this exists for (2026-09-08 vgpu-labs-demo): the branch is
 * checked out in ANOTHER worktree that carries ACTIVE uncommitted work —
 * runPrepare's worktree guard refuses, and the operator hand-rolls a
 * detached-copy rebase. These gates pin the guards and the flow with fakes:
 * no real git, no real worktrees, fully hermetic.
 */
import { describe, expect, test } from "bun:test";
import type { PrepareClient } from "../src/prepare-recipe.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";
import { runViaTempBranch } from "../src/via-temp-branch.ts";

const REMOTE_HEAD = "c".repeat(40);
const REPO = "/repo";
const HOLDER = "/elsewhere/worktree";

/** Fake client: the branch IS held at HOLDER (the mode's precondition). */
function client(opts: { held?: boolean; localHead?: string } = {}): PrepareClient {
  return {
    currentBranch: async () => "main",
    defaultBranch: async () => "main",
    revParse: async (rev: string) => {
      if (rev === "origin/main") return REMOTE_HEAD;
      if (rev === "origin/feature") return REMOTE_HEAD;
      if (rev === "feature") return opts.localHead ?? REMOTE_HEAD;
      if (rev === "HEAD") return REMOTE_HEAD;
      throw new Error(`unexpected rev ${rev}`);
    },
    worktreeList: async () => (opts.held === false ? [] : [{ worktree: HOLDER, branch: "feature" }]),
    aheadBehind: async () => ({ ahead: 0, behind: 0 }),
  } as PrepareClient;
}

/** Recording spawn: succeeds for the flow's commands, fails when scripted. */
function spawn(script: { failWorktreeAdd?: boolean; rebaseConflict?: boolean; failPush?: boolean } = {}) {
  const calls: Array<{ dir: string; args: string[] }> = [];
  const fn: SpawnFn = async (cmd, args, options) => {
    const dir = options?.cwd ?? "";
    calls.push({ dir, args });
    const result = (exitCode: number, stdout = "", stderr = ""): SpawnResult => ({
      stdout,
      stderr,
      exitCode,
    });
    // The module's git() helper prepends `-C <dir>` — match on the verb
    // ANYWHERE in args, not at a fixed position.
    if (args.includes("worktree")) {
      if (args.includes("add")) {
        return result(script.failWorktreeAdd ? 128 : 0, "", script.failWorktreeAdd ? "fatal:" : "");
      }
      if (args.includes("remove")) return result(0);
    }
    if (args.includes("rebase")) {
      return script.rebaseConflict ? result(1, "", "CONFLICT") : result(0);
    }
    if (args.includes("push")) {
      return result(script.failPush ? 1 : 0, "", script.failPush ? "! [rejected]" : "");
    }
    if (args.includes("rev-parse")) return result(0, REMOTE_HEAD);
    return result(0);
  };
  return { fn, calls };
}

const base = {
  client: client(),
  pr: 2182,
  prHeadSha: REMOTE_HEAD,
  prState: "OPEN",
  branch: "feature",
  base: "origin/main",
  remote: "origin",
};

async function run(overrides: Partial<Parameters<typeof runViaTempBranch>[0]> = {}) {
  const opts = { ...base, repoRoot: REPO, spawn: spawn().fn, ...overrides };
  return runViaTempBranch(opts);
}

describe("runViaTempBranch — guards", () => {
  test("closed PR → pr-not-open, zero commands", async () => {
    const spawnRec = spawn();
    const out = await runViaTempBranch({
      ...base,
      repoRoot: REPO,
      spawn: spawnRec.fn,
      prState: "MERGED",
    });
    expect(out.aborted?.reason).toBe("pr-not-open");
    expect(out.commands).toEqual([]);
  });

  test("PR head ≠ remote branch tip → head-mismatch (never rebase a moved PR)", async () => {
    const out = await run({ ...base, prHeadSha: "d".repeat(40), spawn: spawn().fn });
    expect(out.aborted?.reason).toBe("head-mismatch");
  });

  test("branch NOT held elsewhere → not-held-elsewhere, hints at the normal path", async () => {
    const out = await run({ client: client({ held: false }), spawn: spawn().fn });
    expect(out.aborted?.reason).toBe("not-held-elsewhere");
    expect(out.aborted?.message).toContain("normal prepare path");
  });

  test("local-only commits on the holder's branch → loud warning, not an abort", async () => {
    const rec = spawn();
    const out = await runViaTempBranch({
      ...base,
      repoRoot: REPO,
      spawn: rec.fn,
      client: client({ localHead: "a".repeat(40) }),
    });
    expect(out.aborted).toBeUndefined();
    expect(out.warnings.some((w) => w.includes("local-only commits"))).toBe(true);
  });
});

describe("runViaTempBranch — the flow", () => {
  test("happy path: detached temp worktree at the remote head, rebase, targeted force-push, remove", async () => {
    const rec = spawn();
    const out = await runViaTempBranch({ ...base, repoRoot: REPO, spawn: rec.fn });
    expect(out.aborted).toBeUndefined();
    expect(out.viaTempBranch?.removed).toBe(true);
    expect(out.viaTempBranch?.rebasedTo).toBe(REMOTE_HEAD);

    const worktreeAdd = rec.calls.find((c) => c.args.includes("worktree") && c.args.includes("add"));
    expect(worktreeAdd?.args).toContain("--detach");
    expect(worktreeAdd?.args).toContain(REMOTE_HEAD);
    // The rebase happens INSIDE the temp copy, against the base. git() carries
    // the dir via `-C <dir>` (args[1]), so assert on the recorded args.
    const rebase = rec.calls.find((c) => c.args.includes("rebase"));
    expect(rebase?.args[1]).toBeDefined();
    expect(String(rebase?.args[1])).toContain("via-temp-");
    expect(rebase?.args).toContain("origin/main");
    // The push is a targeted ref-spec force-with-lease from the temp copy.
    const push = rec.calls.find((c) => c.args.includes("push"));
    expect(push?.args).toContain("--force-with-lease");
    expect(push?.args).toContain("HEAD:refs/heads/feature");
    // The HOLDER worktree is never touched: no call runs inside it.
    expect(rec.calls.some((c) => c.dir === HOLDER)).toBe(false);
  });

  test("rebase conflict → temp-rebase-conflict, temp worktree KEPT with the aborted rebase", async () => {
    const rec = spawn({ rebaseConflict: true });
    const out = await runViaTempBranch({ ...base, repoRoot: REPO, spawn: rec.fn });
    expect(out.aborted?.reason).toBe("temp-rebase-conflict");
    expect(out.aborted?.message).toContain("worktree kept at");
    const abortCall = rec.calls.find((c) => c.args.includes("--abort"));
    expect(abortCall).toBeDefined();
    expect(rec.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(false);
  });

  test("push failure → temp-push-failed, temp worktree kept", async () => {
    const rec = spawn({ failPush: true });
    const out = await runViaTempBranch({ ...base, repoRoot: REPO, spawn: rec.fn });
    expect(out.aborted?.reason).toBe("temp-push-failed");
    expect(rec.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toBe(false);
  });

  test("worktree add failure → temp-worktree-add-failed, nothing pushed", async () => {
    const rec = spawn({ failWorktreeAdd: true });
    const out = await runViaTempBranch({ ...base, repoRoot: REPO, spawn: rec.fn });
    expect(out.aborted?.reason).toBe("temp-worktree-add-failed");
    expect(rec.calls.some((c) => c.args[0] === "push")).toBe(false);
  });
});

describe("runViaTempBranch — dryRun", () => {
  test("records the plan, spawns nothing", async () => {
    const rec = spawn();
    const out = await runViaTempBranch({ ...base, repoRoot: REPO, spawn: rec.fn, dryRun: true });
    expect(out.commands.length).toBeGreaterThan(0);
    expect(rec.calls.length).toBe(0);
  });
});
