/**
 * Opt-in commit-scope guardrail helpers for the `subagent` tool.
 *
 * Motivation (recurring failure mode): a dispatched implementer/fix subagent
 * runs `git add -A` and sweeps an untracked scratch file (`.planning/…`,
 * `.superpowers/sdd/`, a stray stub) into its commit. On squash-merge that
 * stray file lands on `main`, requiring a follow-up cleanup PR. The SDD
 * implementer prompt is byte-identical to upstream (do not edit — see
 * sdd-report.ts) and only says "commit your work"; the *how* (scoped
 * `git add <paths>` vs `git add -A`) leaks, so the guard belongs at the
 * tool layer, not in the prompt.
 *
 * This module is opt-in DETECTION, not prevention: the child has raw `bash`,
 * so blocking `git add -A` would need a sandbox. Instead, the `subagent` tool
 * records the repo's HEAD before dispatch and, after the run, diffs
 * `base..HEAD` to find which paths the child committed, then flags any that
 * fall outside the caller-declared `commitScope`. Non-destructive — it never
 * reverts; it surfaces the violation to the controller. Best-effort
 * throughout: a non-repo cwd or any git error skips the check silently and
 * can never fail the run.
 *
 * Only the real-tree case is checked. A worktree-isolated run (`spawnCwd` is a
 * throwaway worktree on its own branch) is discarded after teardown, so it can
 * never pollute the parent tree — checking it would be pure noise. The caller
 * (subagent-tool.ts) gates on `spawnCwd === runCwd` before invoking this.
 *
 * The `base..HEAD` range matches the SDD skill's own `review-package BASE HEAD`
 * convention (and avoids the `HEAD~1` multi-commit truncation trap the skill
 * warns about).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SubagentScopeCheck } from "@repo/pi-agent-core-runtime";

const exec = promisify(execFile);

/**
 * The result of an opt-in commit-scope check on one `subagent` run.
 * Surfaced on `SubagentToolDetails.scopeCheck` and persisted on the run record.
 */
export type { SubagentScopeCheck } from "@repo/pi-agent-core-runtime";

/** Injectable git operations (mirrors the spawn/worktree injection seams). */
export interface GitScopeOps {
  /** Resolve the HEAD sha of `cwd`; `undefined` if not a git repo or git fails. */
  headCommit(cwd: string): Promise<string | undefined>;
  /** List paths changed across `base..head` (`git diff --name-only`). Empty on failure. */
  changedPaths(cwd: string, base: string, head: string): Promise<string[]>;
}

/** Production git ops. Every call swallows errors — scope-guard diagnostics never throw. */
export const realGitOps: GitScopeOps = {
  async headCommit(cwd: string): Promise<string | undefined> {
    try {
      const { stdout } = await exec("git", ["-C", cwd, "rev-parse", "HEAD"]);
      const sha = stdout.trim();
      return sha || undefined;
    } catch {
      return undefined;
    }
  },
  async changedPaths(cwd: string, base: string, head: string): Promise<string[]> {
    try {
      const { stdout } = await exec("git", ["-C", cwd, "diff", "--name-only", `${base}..${head}`]);
      return stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  },
};

/** Normalize a scope entry: strip a leading `./` and any trailing `/`. */
function normalizeScopeEntry(entry: string): string {
  return entry.replace(/^\.\//, "").replace(/\/+$/, "").trim();
}

/** Normalize a touched path the same way (strip leading `./`). */
function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").trim();
}

/**
 * Pure: classify which `touched` paths fall OUTSIDE `scope`. A scope entry
 * covers a touched path when they are equal or the touched path lives under
 * `<entry>/` — so entries work as both files (`src/a.ts`) and dirs (`src/`).
 *
 * An empty (normalized) scope means nothing is in scope, so EVERY touched path
 * is out of scope: this covers the "read-only subagent, flag any commit" case
 * (`commitScope: []`). Returns the out-of-scope paths in input order.
 */
export function outOfScopePaths(touched: readonly string[], scope: readonly string[]): string[] {
  const normScope = scope.map(normalizeScopeEntry).filter(Boolean);
  return touched.filter((p) => {
    const t = normalizePath(p);
    if (!t) return false;
    if (normScope.length === 0) return true; // empty scope ⇒ everything is out of scope
    return !normScope.some((entry) => t === entry || t.startsWith(`${entry}/`));
  });
}

/**
 * Run a commit-scope check for one completed subagent run. `base` is the
 * pre-dispatch HEAD (recorded by the caller). Returns the scope check, or
 * `undefined` when there is nothing to check (`base` missing, or the repo HEAD
 * can't be resolved after the run).
 *
 * Best-effort: git failures yield a check with empty `touchedPaths` rather than
 * throwing — the scope guard never fails the run. When `base === head` (the
 * child committed nothing), `touchedPaths` and `outOfScope` are both empty and
 * `headCommit` is omitted.
 */
export async function computeScopeCheck(
  ops: GitScopeOps,
  cwd: string,
  base: string | undefined,
  scope: readonly string[],
): Promise<SubagentScopeCheck | undefined> {
  if (base === undefined) return undefined;
  try {
    const head = await ops.headCommit(cwd);
    if (head === undefined) return undefined; // not a repo / git broke after the run
    const touched = base === head ? [] : await ops.changedPaths(cwd, base, head);
    const outOfScope = outOfScopePaths(touched, scope);
    const check: SubagentScopeCheck = { baseCommit: base, touchedPaths: touched, outOfScope };
    if (base !== head) check.headCommit = head;
    return check;
  } catch {
    // Best-effort: a throwing op (e.g. a flaky git invocation) must never fail
    // the subagent run. realGitOps already swallows internally; this guards an
    // injected/test op that throws. Matches the module's never-throws contract.
    return undefined;
  }
}
