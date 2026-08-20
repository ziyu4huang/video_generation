/**
 * Real-git harness for the project-memory autocommit integration suite
 * (ticket 08 / build ticket 02).
 *
 * Each scenario gets a FRESH tmpdir + `git init` — zero shared repo state —
 * and drives `realGitOps` (and the real hook) against actual `git`. This is
 * the gap the mock unit tests (tests/handlers/commit-project-memory.test.ts)
 * provably can't reach: real pathspec-limited commits, real branch topology,
 * and a real §-union merge driver invoked by `git merge`.
 *
 * Reuses the established mkdtemp+tmpdir pattern (tests/config.test.ts,
 * tests/integration/flow.test.ts). No new deps — node:fs + node:child_process.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ENTRY_DELIMITER, MEMORY_MERGE_DRIVER_NAME } from "../../src/constants.js";
import { buildMergeDriverCommand, mergeDriverConfigKey } from "../../src/git-ops.js";

export interface CreateRepoOpts {
  /** §-entries written to the initial MEMORY.md. Default: one base entry. */
  initialMemoryEntries?: string[];
  /** Self-config the §-union merge driver (git config + .gitattributes) for real-merge tests. */
  configureMergeDriver?: boolean;
  /** Create + checkout this branch after the initial commit. null = stay on the init branch (main). Default: "feature/test". */
  featureBranch?: string | null;
}

export interface RealGitRepo {
  /** Absolute tmpdir root (the repo working tree). */
  readonly cwd: string;
  /** Absolute path to MEMORY.md. */
  readonly memoryFilePath: string;
  /** Repo-relative MEMORY.md path (what git add/commit receive). */
  readonly memoryRelPath: string;
  /** Absolute path to the `.git` dir. */
  readonly gitDir: string;
  /** Run `git -C <cwd> <args>`; returns trimmed stdout. Throws on non-zero exit. */
  run(args: string[]): string;
  /** Run git; true on exit 0, false otherwise (never throws). */
  ok(args: string[]): boolean;
  /** Overwrite MEMORY.md with these §-entries. */
  writeMemoryEntries(...entries: string[]): void;
  /** Append §-entries to MEMORY.md (preserves the §-delimited format). */
  appendMemoryEntries(...entries: string[]): void;
  /** Current branch name. */
  branch(): string;
  /** `git rev-parse HEAD`. */
  head(): string;
  /** Number of commits reachable from HEAD. */
  logCount(): number;
  /** Subject line of a commit (default HEAD). */
  commitSubject(ref?: string): string;
  /** Files changed in a commit (default HEAD), repo-relative. */
  commitFiles(ref?: string): string[];
  /** `git diff --cached --name-only` — staged-but-uncommitted files. */
  stagedFiles(): string[];
  /** Branch names whose history contains `sha`. */
  branchesContaining(sha: string): string[];
  /** Read MEMORY.md content. */
  readMemory(): string;
  /** rm -rf the tmpdir (best effort). */
  cleanup(): void;
}

function splitEntries(content: string): string[] {
  return content.split(ENTRY_DELIMITER).map((e) => e.trim()).filter((e) => e.length > 0);
}

/**
 * Create a fresh opted-in git repo in a tmpdir: init + identity + MEMORY.md +
 * config.json (autoCommitProjectMemory:true) + initial commit, then (optionally)
 * checkout a feature branch so the autocommit hook is not on a protected branch.
 */
export function createRealGitRepo(opts: CreateRepoOpts = {}): RealGitRepo {
  const initialEntries = opts.initialMemoryEntries ?? ["Base memory entry one"];
  const featureBranch = opts.featureBranch === undefined ? "feature/test" : opts.featureBranch;

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-autocommit-"));
  const memoryDir = path.join(cwd, ".agents", "memory");
  const memoryRelPath = path.join(".agents", "memory", "MEMORY.md");
  const memoryFilePath = path.join(cwd, memoryRelPath);
  const configRelPath = path.join(".agents", "memory", "config.json");
  const gitDir = path.join(cwd, ".git");

  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(memoryFilePath, initialEntries.join(ENTRY_DELIMITER) + "\n");
  fs.writeFileSync(path.join(cwd, configRelPath), JSON.stringify({ autoCommitProjectMemory: true }));

  const initialFiles = [memoryRelPath, configRelPath];
  if (opts.configureMergeDriver) {
    const gitattributesRel = path.join(".agents", "memory", ".gitattributes");
    fs.writeFileSync(path.join(cwd, gitattributesRel), `MEMORY.md merge=${MEMORY_MERGE_DRIVER_NAME}\n`);
    initialFiles.push(gitattributesRel);
  }

  const exec = (args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });

  exec(["init", "-q", "-b", "main"]);
  exec(["config", "user.email", "autocommit-test@example.com"]);
  exec(["config", "user.name", "Autocommit Test"]);
  if (opts.configureMergeDriver) {
    exec(["config", mergeDriverConfigKey("name"), "Pi memory section-union"]);
    exec(["config", mergeDriverConfigKey("driver"), buildMergeDriverCommand()]);
  }
  // Stage ONLY the explicit initial files — never `-A`/`.` (the hook never does either).
  exec(["add", "--", ...initialFiles]);
  exec(["commit", "-q", "-m", "chore: initial project memory"]);
  if (featureBranch) exec(["checkout", "-q", "-b", featureBranch]);

  return {
    cwd,
    memoryFilePath,
    memoryRelPath,
    gitDir,
    run: (args) => exec(args).trim(),
    ok: (args) => {
      try {
        exec(args);
        return true;
      } catch {
        return false;
      }
    },
    writeMemoryEntries: (...entries) => {
      fs.writeFileSync(memoryFilePath, entries.join(ENTRY_DELIMITER) + "\n");
    },
    appendMemoryEntries: (...entries) => {
      const all = [...splitEntries(fs.readFileSync(memoryFilePath, "utf-8")), ...entries];
      fs.writeFileSync(memoryFilePath, all.join(ENTRY_DELIMITER) + "\n");
    },
    branch: () => exec(["symbolic-ref", "--quiet", "--short", "HEAD"]).trim(),
    head: () => exec(["rev-parse", "HEAD"]).trim(),
    logCount: () => Number(exec(["rev-list", "--count", "HEAD"]).trim()),
    commitSubject: (ref = "HEAD") => exec(["show", "-s", "--format=%s", ref]).trim(),
    commitFiles: (ref = "HEAD") =>
      exec(["diff-tree", "--no-commit-id", "--name-only", "-r", ref])
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    stagedFiles: () =>
      exec(["diff", "--cached", "--name-only"])
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    branchesContaining: (sha) =>
      exec(["branch", "--contains", sha])
        .split("\n")
        .map((s) => s.replace(/^\*/, "").trim())
        .filter(Boolean),
    readMemory: () => fs.readFileSync(memoryFilePath, "utf-8"),
    cleanup: () => {
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
      } catch {
        // best effort — tmpdir is under os.tmpdir() either way
      }
    },
  };
}
