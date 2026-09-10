/**
 * via-temp-branch — MC-3 (self-arc-15): rebase a branch that is CHECKED OUT
 * in another worktree, without touching that worktree.
 *
 * The 2026-09-08 incident (vgpu-labs-demo): the branch was held by the
 * `video_generation__memory` worktree, which carried ACTIVE uncommitted work —
 * runPrepare's triple worktree guard (correctly) refused, and the operator had
 * to hand-roll the workaround: rebase a detached TEMP copy, resolve there,
 * force-push the PR head, leave the holder alone. This module makes that
 * workaround first-class, with guards:
 *
 *   1. `pr-not-open`       — the PR must be OPEN.
 *   2. `head-mismatch`     — `<remote>/<branch>` must equal the PR's headRefOid
 *                            (the temp copy rebases exactly what the PR shows).
 *   3. `not-held-elsewhere`— the mode is ONLY for the held-elsewhere case; the
 *                            normal prepare path handles everything else.
 *   4. local divergence is a WARNING (local-only commits will NOT ride along).
 *
 * Flow: `git worktree add --detach <tmp> <remoteHead>` → `git rebase <base>`
 * inside <tmp> (never checking the branch out anywhere) → `git push
 * --force-with-lease <remote> <sha>:refs/heads/<branch>` → `git worktree
 * remove <tmp>`. On a rebase conflict the temp worktree is KEPT with the
 * half-resolved state and the abort names its path.
 *
 * Throw-free + dryRun discipline mirrors runPrepare (prepare-recipe.ts).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrepareClient } from "./prepare-recipe.js";
import type { SpawnFn, SpawnResult } from "./spawn.js";

export const VIA_TEMP_ABORT_REASONS = [
  "pr-not-open",
  "head-mismatch",
  "not-held-elsewhere",
  "temp-worktree-add-failed",
  "temp-rebase-conflict",
  "temp-push-failed",
] as const;

export type ViaTempAbortReason = (typeof VIA_TEMP_ABORT_REASONS)[number];

export interface ViaTempBranchOptions {
  client: PrepareClient;
  spawn: SpawnFn;
  repoRoot: string;
  /** Target branch (required). */
  branch: string;
  /** Rebase base, e.g. `origin/main` (required). */
  base: string;
  /** Force-push remote (default `origin`). */
  remote?: string;
  /** The open PR number the branch belongs to (guard + reporting). */
  pr: number;
  /** The PR's current head SHA — guards against rebasing a moved PR. */
  prHeadSha: string;
  /** PR state probe: anything but "OPEN" aborts `pr-not-open`. */
  prState: string;
  dryRun?: boolean;
}

export interface ViaTempStep {
  step: string;
  ok: boolean;
}

export interface ViaTempBranchOutcome {
  branch: string;
  pr: number;
  base: string;
  steps: ViaTempStep[];
  commands: string[];
  warnings: string[];
  /** Present on success: where the rebase happened and what it produced. */
  viaTempBranch?: { tempWorktree: string; rebasedTo: string; removed: boolean };
  aborted?: { aborted: true; reason: ViaTempAbortReason; message: string; hint?: string };
}

function trim(s: string | undefined): string {
  return (s ?? "").trim();
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run the guarded temp-branch rebase. Never throws. `dryRun` records the exact
 * commands and spawns nothing.
 */
export async function runViaTempBranch(opts: ViaTempBranchOptions): Promise<ViaTempBranchOutcome> {
  const { client, spawn, repoRoot, branch, base } = opts;
  const pr = opts.pr;
  const remote = opts.remote ?? "origin";
  const dry = opts.dryRun === true;
  const commands: string[] = [];
  const warnings: string[] = [];
  const steps: ViaTempStep[] = [];

  const git = async (dir: string, args: string[]): Promise<SpawnResult> => {
    commands.push(`git -C "${dir}" ${args.join(" ")}`);
    if (dry) return { stdout: "", stderr: "(dry-run) skipped", exitCode: 0 };
    return spawn("git", ["-C", dir, ...args]);
  };
  const outcome = (aborted?: {
    aborted: true;
    reason: ViaTempAbortReason;
    message: string;
    hint?: string;
  }): ViaTempBranchOutcome => ({
    branch,
    pr,
    base,
    steps,
    commands,
    warnings,
    aborted,
  });

  const step = (name: string, ok: boolean) => steps.push({ step: name, ok });

  // Guard 1: the PR must be open.
  if (opts.prState !== "OPEN") {
    return outcome({
      aborted: true,
      reason: "pr-not-open",
      message: `PR #${pr} is ${opts.prState}, not OPEN — nothing to rebase.`,
    });
  }

  // Guard 2: the PR's head must still be the remote branch tip — the temp copy
  // rebases exactly what the PR shows, never a moved tip.
  const remoteHead = trim(await safeRevParse(client, `${remote}/${branch}`, warnings));
  if (!remoteHead) {
    return outcome({
      aborted: true,
      reason: "head-mismatch",
      message: `cannot resolve ${remote}/${branch} — fetch first, then re-run.`,
    });
  }
  if (opts.prHeadSha && opts.prHeadSha !== remoteHead) {
    return outcome({
      aborted: true,
      reason: "head-mismatch",
      message: `PR #${pr} head (${opts.prHeadSha.slice(0, 12)}) ≠ ${remote}/${branch} (${remoteHead.slice(0, 12)}) — the PR moved; re-fetch and re-run.`,
    });
  }

  // Guard 3: this mode exists FOR the held-elsewhere case. When the branch is
  // NOT held anywhere, the normal prepare path is the right tool — refuse here
  // so the holder-aware semantics can never be exercised by accident.
  const worktrees = await safeList(client, warnings);
  const holder = worktrees.find((w) => w.branch === branch && w.worktree !== repoRoot);
  if (!holder) {
    return outcome({
      aborted: true,
      reason: "not-held-elsewhere",
      message: `branch '${branch}' is not checked out in any other worktree — use the normal prepare path (--rebase --force-push).`,
    });
  }
  // Guard 4 (advisory): local-only commits on the holder's branch will NOT be
  // part of this rebase — say so loudly instead of silently dropping them.
  const localHead = trim(await safeRevParse(client, branch, warnings));
  if (localHead && localHead !== remoteHead) {
    warnings.push(
      `local branch '${branch}' (${localHead.slice(0, 12)}) is ahead of ${remote}/${branch} ` +
        `(${remoteHead.slice(0, 12)}) — those local-only commits are NOT included in this rebase.`,
    );
  }

  // Flow: detached temp worktree at the remote head → rebase → force-push the
  // branch ref to the rebased SHA → remove the temp worktree.
  const tempWorktree: string = dry ? "<temp-dir>" : mkdtempSync(join(tmpdir(), "via-temp-"));
  let rebasedTo = "";
  let removed = false;

  const add = await git(repoRoot, ["worktree", "add", "--detach", tempWorktree, remoteHead]);
  step("worktree-add", add.exitCode === 0);
  if (add.exitCode !== 0) {
    rmSync(tempWorktree, { recursive: true, force: true });
    return outcome({
      aborted: true,
      reason: "temp-worktree-add-failed",
      message: `git worktree add --detach failed: ${trim(add.stderr || add.stdout)}`,
    });
  }
  if (!tempWorktree || tempWorktree === "<temp-dir>") {
    // dry-run: no real dir exists; report the plan without lifecycle steps.
    return {
      branch,
      pr,
      base,
      steps,
      commands,
      warnings,
      viaTempBranch: { tempWorktree: tempWorktree || "<temp-dir>", rebasedTo: "", removed: false },
    };
  }

  const rb = await git(tempWorktree, ["rebase", base]);
  step("rebase", rb.exitCode === 0);
  if (rb.exitCode !== 0) {
    warnings.push(`rebase ${base} failed: ${trim(rb.stderr || rb.stdout)}`);
    await git(tempWorktree, ["rebase", "--abort"]);
    return outcome({
      aborted: true,
      reason: "temp-rebase-conflict",
      message: `temp-copy rebase onto ${base} hit conflicts (worktree kept at ${tempWorktree}); rebase aborted.`,
      hint: `resolve inside ${tempWorktree}, then git push --force-with-lease ${remote} HEAD:refs/heads/${branch}`,
    });
  }

  rebasedTo = dry ? "<rebased-sha>" : trim((await git(tempWorktree, ["rev-parse", "HEAD"])).stdout);
  const push = await git(tempWorktree, ["push", "--force-with-lease", remote, `HEAD:refs/heads/${branch}`]);
  step("push", push.exitCode === 0);
  if (push.exitCode !== 0) {
    warnings.push(`force-push to ${remote}/${branch} failed: ${trim(push.stderr || push.stdout)}`);
    return outcome({
      aborted: true,
      reason: "temp-push-failed",
      message: `push --force-with-lease ${remote} HEAD:refs/heads/${branch} failed (temp worktree kept at ${tempWorktree}).`,
      hint: "fetch + inspect, then push manually and remove the temp worktree.",
    });
  }

  if (!dry) {
    try {
      await spawn("git", ["-C", repoRoot, "worktree", "remove", tempWorktree]);
      rmSync(tempWorktree, { recursive: true, force: true });
      removed = true;
    } catch (err) {
      warnings.push(`temp worktree remove failed (left in place): ${errMsg(err)}`);
    }
  }

  return {
    branch,
    pr,
    base,
    steps,
    commands,
    warnings,
    viaTempBranch: { tempWorktree, rebasedTo, removed },
  };
}

async function safeRevParse(client: PrepareClient, rev: string, warnings: string[]): Promise<string> {
  try {
    return ((await client.revParse(rev)) ?? "").trim();
  } catch (err) {
    warnings.push(`revParse ${rev} failed: ${errMsg(err)}`);
    return "";
  }
}

async function safeList(
  client: PrepareClient,
  warnings: string[],
): Promise<Array<{ worktree: string; branch?: string }>> {
  try {
    return await client.worktreeList();
  } catch (err) {
    warnings.push(`worktreeList failed: ${errMsg(err)}`);
    return [];
  }
}
