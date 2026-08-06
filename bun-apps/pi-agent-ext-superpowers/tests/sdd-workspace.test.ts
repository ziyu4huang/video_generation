import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Golden-output coverage for the sdd-workspace pi-port glue. The script is the
 * single source of truth for where one plan's SDD artifacts land, with two
 * branches keyed on PI_PLANNING_EFFORT:
 *   - set  → $root/.planning/$effort/sdd/$slug   (committed audit trail)
 *   - unset → $root/.planning/sdd/$slug          (flat local-only, gitignored)
 * A mis-derivation silently lands briefs/reports/progress in the wrong tree, so
 * both branches + the slug derivation are locked in here. Runs the real script
 * (bash) inside a throwaway git repo so its `git rev-parse --show-toplevel`
 * resolves — mirrors the repo's scripts/pr-finish.test.ts precedent for
 * shell-script decision-logic tests.
 */
const SCRIPT = resolve(import.meta.dir, "../skills/subagent-driven-development/scripts/sdd-workspace");

/** A throwaway git repo so the script's `git rev-parse --show-toplevel` resolves.
 *  realpathSync: macOS $TMPDIR is /var/... (a symlink to /private/var/...); the
 *  script's `cd ... && pwd` resolves it, so the repo path must be canonical too
 *  or the path assertions mismatch on the /var vs /private/var prefix. */
function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sdd-ws-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t.t"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "test"], { cwd: dir });
  return realpathSync(dir);
}

/** Write a plan file (creating parents) at an arbitrary path under the repo. */
function writePlan(repo: string, relPath: string): string {
  const plan = join(repo, ...relPath.split("/"));
  mkdirSync(dirname(plan), { recursive: true });
  writeFileSync(plan, "# plan\n"); // existence is all the script checks
  return plan;
}

/** Run sdd-workspace once; return { stdout, status }. cwd = the temp repo root. */
function run(planAbsPath: string, cwd: string, env: Record<string, string>): { stdout: string; status: number | null } {
  const r = spawnSync("bash", [SCRIPT, planAbsPath], { cwd, env: { ...process.env, ...env } });
  return { stdout: r.stdout.toString().trim(), status: r.status };
}

// PORTABILITY-GUARDED: this suite spawns `bash` + `git` to exercise the REAL
// committed sdd-workspace script (skills/subagent-driven-development/scripts/
// sdd-workspace). bash, git, and a committed repo script are present on every
// CI runner (ubuntu-latest) and dev machine, so this spawn is CI-safe — it is
// NOT a machine-coupled host-binary probe. Unlike the stable
// run-self-improve-loop glue (which stays CI-skipped under the portability
// convention because that code rarely changes), the no-effort SDD fallback is
// actively-maintained behavior (settled in PR #1038 / ADR-0007) and warrants CI
// coverage. Hermetic: mkdtemp + git init + cleanup.
describe("sdd-workspace (pi-port effort nesting)", () => {
  it("routes to .planning/$effort/sdd/$slug when PI_PLANNING_EFFORT is set", () => {
    const repo = makeTempRepo();
    try {
      const plan = writePlan(repo, "plans/add-auth.md");
      const { stdout, status } = run(plan, repo, { PI_PLANNING_EFFORT: "2026-07-26-foo" });
      expect(status).toBe(0);
      expect(stdout).toBe(join(repo, ".planning", "2026-07-26-foo", "sdd", "add-auth"));
      expect(existsSync(stdout)).toBe(true); // mkdir -p created it
      // effort branch does NOT write a blanket .gitignore (audit trail is committed)
      expect(existsSync(join(repo, ".planning", "2026-07-26-foo", "sdd", ".gitignore"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("falls back to .planning/sdd/$slug (gitignored) when no effort", () => {
    const repo = makeTempRepo();
    try {
      const plan = writePlan(repo, "plans/big-refactor.md");
      const { stdout, status } = run(plan, repo, { PI_PLANNING_EFFORT: "" });
      expect(status).toBe(0);
      expect(stdout).toBe(join(repo, ".planning", "sdd", "big-refactor"));
      expect(existsSync(stdout)).toBe(true);
      // no-effort branch no longer writes a per-dir self-ignore (repo-level
      // .gitignore: .planning/sdd/ covers it); flat path is local-only scratch.
      expect(existsSync(join(repo, ".planning", "sdd", ".gitignore"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("derives the slug from the plan basename, not a deeper path", () => {
    const repo = makeTempRepo();
    try {
      const plan = writePlan(repo, "plans/nested/deep/cool.md");
      const { stdout, status } = run(plan, repo, { PI_PLANNING_EFFORT: "e1" });
      expect(status).toBe(0);
      expect(stdout.endsWith(join(".planning", "e1", "sdd", "cool"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
