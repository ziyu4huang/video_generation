/**
 * sync-repo.test.ts — deterministic tests for sync-repo.sh's default-branch
 * detection.
 *
 * sync-repo.sh used to hardcode `main` in ~10 places (the `--full` superproject
 * worktree logic, every `git submodule foreach` checkout/pull, and the alignment
 * report). That breaks on repos/submodules whose default branch is `master`,
 * `develop`, etc. The fix centralizes detection in `detect_default_branch()`
 * (origin/HEAD → `git remote show origin` → fallback `main`), exposed both as a
 * function and a lib-mode flag (`--detect-default-branch`).
 *
 * This suite verifies the detection logic TWO ways:
 *   1. UNIT — sed-extract detect_default_branch() from the REAL script and source
 *      it (mirrors pr-finish.test.ts / multi-hop-eval.test.ts "as shipped"). No
 *      network: origin/HEAD is seeded with `git symbolic-ref` so every branch
 *      name (main / master / develop / release-v2 / none) is tested deterministically.
 *   2. LIB-MODE (integration) — run `bash sync-repo.sh --detect-default-branch
 *      <repo>` AS SHIPPED, asserting exit 0, clean stderr, correct stdout, and
 *      no side effects (the lib path must short-circuit before any fetch/sync).
 *
 * Run: `bun test scripts/sync-repo.test.ts`
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPTS = import.meta.dirname;
const SYNC_REPO = join(SCRIPTS, "sync-repo.sh");

let funcsFile = "";
const tmpDirs: string[] = [];

beforeAll(() => {
  if (!existsSync(SYNC_REPO)) throw new Error(`sync-repo.sh not found at ${SYNC_REPO}`);
  // Extract the pure functions from the REAL script ONCE (sourcing the full
  // script would EXECUTE the sync, so we lift just the functions — same trick
  // pr-finish.test.ts uses for ci_running/wait_ci). Both detect_default_branch()
  // and verify_default_at_latest() are self-contained (no script globals), so a
  // single sourced file gives the unit tests both.
  funcsFile = join(tmpdir(), `sr-funcs-${process.pid}-${crypto.randomUUID()}.sh`);
  execFileSync("bash", [
    "-c",
    `sed -n '/^detect_default_branch()/,/^}/p' "${SYNC_REPO}" > "${funcsFile}" && ` +
    `sed -n '/^verify_default_at_latest()/,/^}/p' "${SYNC_REPO}" >> "${funcsFile}"`,
  ]);
  if (!existsSync(funcsFile) || statSync(funcsFile).size === 0) {
    throw new Error("sed extraction of functions produced an empty file");
  }
});

afterAll(() => {
  try {
    rmSync(funcsFile);
  } catch {
    /* best-effort */
  }
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

/**
 * Create a temp git repo. If <headBranch> is given, seed origin/HEAD to point at
 * it via `git symbolic-ref` — this needs NO real remote/branch, so every branch
 * name is testable fully offline. Omit <headBranch> for the fallback case
 * (no origin/HEAD, no origin remote).
 */
function mkRepo(headBranch?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sr-"));
  tmpDirs.push(dir);
  execFileSync("bash", ["-c", `git init -q "${dir}"`]);
  if (headBranch) {
    execFileSync("bash", [
      "-c",
      `git -C "${dir}" symbolic-ref refs/remotes/origin/HEAD "refs/remotes/origin/${headBranch}"`,
    ]);
  }
  return dir;
}

interface BashResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Source the extracted function and call detect_default_branch <repo>. */
async function detectViaSource(repo: string): Promise<BashResult> {
  const snippet = `source "${funcsFile}"; detect_default_branch "${repo}"; echo "EXIT:$?"`;
  return bash(snippet);
}

/** Run the REAL script in lib mode: `bash sync-repo.sh --detect-default-branch <repo>`. */
async function detectViaLibmode(repo: string): Promise<BashResult> {
  return bash(`bash "${SYNC_REPO}" --detect-default-branch "${repo}"; echo "EXIT:$?"`);
}

async function bash(snippet: string): Promise<BashResult> {
  const proc = Bun.spawn(["bash", "-c", snippet], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

function exitOf(r: BashResult): number {
  const m = r.stdout.match(/EXIT:(\d+)/);
  if (!m) throw new Error(`no EXIT marker in:\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
  return Number(m[1]);
}

function branchOf(r: BashResult): string {
  // first non-EXIT line, trimmed
  return r.stdout.replace(/EXIT:\d+/, "").trim();
}

// --- UNIT: detect_default_branch() (sourced from the real script) ------------

test("unit: origin/HEAD → main", async () => {
  expect(branchOf(await detectViaSource(mkRepo("main")))).toBe("main");
});

test("unit: origin/HEAD → master (NOT hardcoded to main)", async () => {
  expect(branchOf(await detectViaSource(mkRepo("master")))).toBe("master");
});

test("unit: origin/HEAD → develop", async () => {
  expect(branchOf(await detectViaSource(mkRepo("develop")))).toBe("develop");
});

test("unit: origin/HEAD → release/v2 strips only the remote prefix", async () => {
  // origin/release/v2 → "release/v2" (must NOT collapse the slash to "v2")
  expect(branchOf(await detectViaSource(mkRepo("release/v2")))).toBe("release/v2");
});

test("unit: no origin/HEAD + no origin remote → fallback 'main' (offline)", async () => {
  const r = await detectViaSource(mkRepo()); // no headBranch seeded
  expect(exitOf(r)).toBe(0);
  expect(branchOf(r)).toBe("main");
});

// --- LIB-MODE (integration): as-shipped `--detect-default-branch` ------------

test("lib-mode: master repo → exit 0, stdout 'master', clean stderr", async () => {
  const r = await detectViaLibmode(mkRepo("master"));
  expect(exitOf(r)).toBe(0);
  expect(branchOf(r)).toBe("master");
  expect(r.stderr.trim()).toBe("");
});

test("lib-mode: fallback repo → exit 0, stdout 'main'", async () => {
  const r = await detectViaLibmode(mkRepo());
  expect(exitOf(r)).toBe(0);
  expect(branchOf(r)).toBe("main");
});

test("lib-mode: produces no side effects (short-circuits before any sync)", async () => {
  // A lib-mode call must not write FETCH_HEAD / touch refs — it only reads
  // origin/HEAD. Seed a repo, snapshot .git, run, assert nothing changed.
  const repo = mkRepo("master");
  const before = execFileSync("bash", ["-c", `find "${repo}/.git" -type f | sort | xargs md5 2>/dev/null`])
    .toString()
    .trim();
  await detectViaLibmode(repo);
  const after = execFileSync("bash", ["-c", `find "${repo}/.git" -type f | sort | xargs md5 2>/dev/null`])
    .toString()
    .trim();
  expect(after).toBe(before);
});

// --- UNIT: verify_default_at_latest() (sourced from the real script) ---------
// This is the --full loud-failure guard: the OLD code printed "✓ Sync complete" +
// exit 0 even when the default-branch advance was silently skipped (dirty sibling
// worktree / no upstream / ff refused), leaving local main behind origin/main.
// verify_default_at_latest() turns that silent success into exit 1 + a message.

/**
 * Build an offline temp repo whose refs simulate a default-branch sync state.
 * mode:
 *   "behind"    — local main is 1 behind origin/main (advance was skipped)
 *   "latest"    — local main == origin/main (synced)
 *   "no-origin" — no origin/main ref at all (remote missing/unfetched)
 */
function mkSyncRepo(mode: "behind" | "latest" | "no-origin"): string {
  const dir = mkdtempSync(join(tmpdir(), "sr-v-"));
  tmpDirs.push(dir);
  const sh = (c: string) => execFileSync("bash", ["-c", c]);
  sh(`git init -q -b main "${dir}"`);
  sh(`git -C "${dir}" commit -q --allow-empty -m base`);
  const base = sh(`git -C "${dir}" rev-parse main`).toString().trim();
  if (mode === "no-origin") return dir; // no origin/main ref seeded
  if (mode === "latest") {
    sh(`git -C "${dir}" update-ref refs/remotes/origin/main "${base}"`);
    return dir;
  }
  // behind: advance origin/main by one commit, then rewind local main to base
  sh(`git -C "${dir}" commit -q --allow-empty -m remote-only`);
  const tip = sh(`git -C "${dir}" rev-parse main`).toString().trim();
  sh(`git -C "${dir}" update-ref refs/remotes/origin/main "${tip}"`);
  sh(`git -C "${dir}" reset -q --hard "${base}"`);
  return dir;
}

/** Source the extracted function and call verify_default_at_latest <repo> <branch>. */
async function verifyViaSource(repo: string, branch: string): Promise<BashResult> {
  const snippet = `source "${funcsFile}"; verify_default_at_latest "${repo}" "${branch}"; echo "EXIT:$?"`;
  return bash(snippet);
}

test("unit: verify_default_at_latest — behind → exit 1 + loud stderr", async () => {
  const r = await verifyViaSource(mkSyncRepo("behind"), "main");
  expect(exitOf(r)).toBe(1);
  expect(r.stderr).toContain("NOT at latest remote");
  expect(r.stderr).toContain("behind 1");
});

test("unit: verify_default_at_latest — at latest → exit 0, silent", async () => {
  const r = await verifyViaSource(mkSyncRepo("latest"), "main");
  expect(exitOf(r)).toBe(0);
  expect(r.stderr.trim()).toBe("");
});

test("unit: verify_default_at_latest — no origin ref → exit 1 + clear message", async () => {
  const r = await verifyViaSource(mkSyncRepo("no-origin"), "main");
  expect(exitOf(r)).toBe(1);
  expect(r.stderr).toContain("cannot resolve");
});
