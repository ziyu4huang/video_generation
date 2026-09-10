/**
 * worktree-doctor-cli — MC-6 (self-arc-15 t06): report (and optionally prune)
 * stale worktree registrations.
 *
 * `git worktree list --porcelain` is the source of truth: prunable entries are
 * registrations whose directory is GONE (or otherwise stale). They are pure
 * litter in `git worktree list` and — worse — they keep `git branch -D`
 * refused for any branch still checked out there, which is exactly why merged
 * branches linger in multi-worktree checkouts (self-arc-14/15 sessions).
 *
 * Contract (mirrors sibling CLIs): JSON report on stdout; exit 0 report /
 * 1 failure / 2 usage. `--prune` runs `git worktree prune` first, then
 * re-lists; the report names what disappeared.
 *
 * Usage: bun src/worktree-doctor-cli.ts [--prune] [--repo-root <path>]
 */
import type { CliResult } from "./cli-common.js";
import { defaultRepoRoot, helpRequested, jsonResult, toStderr, usageError } from "./cli-common.js";
import { createLiveSpawn, type SpawnFn } from "./spawn.js";

export const WORKTREE_DOCTOR_USAGE = [
  "usage: worktree-doctor-cli.ts [--prune] [--repo-root <path>]",
  "",
  "Reports every git worktree registration (path, HEAD, branch, prunable +",
  "reason). With --prune, runs `git worktree prune` first and reports what",
  "disappeared. Pure report otherwise — never deletes a directory itself.",
  "",
  "Exit 0 report · 1 failure · 2 usage error.",
].join("\n");

export interface WorktreeRegistration {
  path: string;
  head: string;
  branch?: string;
  detached?: boolean;
  prunable?: boolean;
  prunableReason?: string;
}

export interface WorktreeDoctorOutcome {
  repoRoot: string;
  pruned: boolean;
  before: WorktreeRegistration[];
  after?: WorktreeRegistration[];
  /** Registrations present before the prune and gone after (prune mode only). */
  removed?: WorktreeRegistration[];
}

/** Parse `git worktree list --porcelain` blocks. Exported for tests. */
export function parseWorktreePorcelain(text: string): WorktreeRegistration[] {
  const out: WorktreeRegistration[] = [];
  let cur: Partial<WorktreeRegistration> | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "") {
      if (cur) {
        out.push(cur as WorktreeRegistration);
        cur = undefined;
      }
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? "" : line.slice(sp + 1);
    if (key === "worktree") cur = { path: value, head: "" };
    else if (key === "HEAD") cur!.head = value;
    else if (key === "branch") cur!.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached") cur!.detached = true;
    else if (key === "prunable") {
      cur!.prunable = true;
      cur!.prunableReason = value;
    }
  }
  if (cur) out.push(cur as WorktreeRegistration);
  return out;
}

export async function runWorktreeDoctorCli(
  argv: string[],
  deps: { spawn?: SpawnFn; repoRoot?: string } = {},
): Promise<CliResult> {
  const prune = argv.includes("--prune");
  for (const a of argv) {
    if (a === "-h" || a === "--help") return { exitCode: 0, stdout: "", stderr: WORKTREE_DOCTOR_USAGE };
    if (a !== "--prune" && !a.startsWith("--repo-root")) {
      return usageError(`unknown argument: ${a}`, WORKTREE_DOCTOR_USAGE);
    }
  }
  const repoRootIdx = argv.indexOf("--repo-root");
  const repoRoot = repoRootIdx >= 0 ? (argv[repoRootIdx + 1] ?? "") : (deps.repoRoot ?? defaultRepoRoot());
  if (!repoRoot) return usageError("--repo-root needs a value", WORKTREE_DOCTOR_USAGE);
  const spawn = deps.spawn ?? createLiveSpawn(repoRoot);

  const list = async (): Promise<WorktreeRegistration[]> => {
    const r = await spawn("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
    if (r.exitCode !== 0) throw new Error(`git worktree list failed: ${trim(r.stderr)}`);
    return parseWorktreePorcelain(r.stdout);
  };

  let before: WorktreeRegistration[];
  try {
    before = await list();
  } catch (err) {
    return { exitCode: 1, stdout: "", stderr: `worktree-doctor: ${errMsg(err)}` };
  }

  let after: WorktreeRegistration[] | undefined;
  let removed: WorktreeRegistration[] | undefined;
  if (prune) {
    try {
      await spawn("git", ["-C", repoRoot, "worktree", "prune"]);
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: `worktree-doctor: prune failed: ${errMsg(err)}` };
    }
    after = await list();
    const beforePaths = new Set(before.map((w) => w.path));
    const afterPaths = new Set((after ?? []).map((w) => w.path));
    removed = before.filter((w) => beforePaths.has(w.path) && !afterPaths.has(w.path));
  }

  const outcome: WorktreeDoctorOutcome = {
    repoRoot,
    pruned: prune === true,
    before,
    ...(prune ? { after, removed } : {}),
  };
  return { exitCode: 0, stdout: JSON.stringify(outcome, null, 2), stderr: "" };
}

function trim(s: string): string {
  return (s ?? "").trim();
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

if (import.meta.main) {
  const res = await runWorktreeDoctorCli(process.argv.slice(2));
  if (res.stderr) toStderr(res.stderr);
  if (res.stdout) process.stdout.write(`${res.stdout}\n`);
  process.exit(res.exitCode);
}
