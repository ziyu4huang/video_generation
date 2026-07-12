/**
 * pr-finish.test.ts — deterministic decision-logic tests for pr-finish.sh.
 *
 * pr-finish.sh is the most-dogfooded script in the repo but had ZERO automated
 * tests. Its CI-gating decisions (ci_running, wait_ci's aggregate gate, the
 * registration poll, the required-mode branching) live in timing-dependent
 * paths that live dogfooding rarely triggers distinctly (BLOCKED-while-pending,
 * the seconds-after-push registration gap, flake states). This suite verifies
 * them deterministically with a FAKE `gh` on PATH (canned check-state JSON), so
 * a regression in the jq decision logic or the required-mode branching is
 * caught without a live PR.
 *
 * Philosophy: sources the REAL ci_running() + wait_ci() extracted from
 * pr-finish.sh (sed), exercising the actual jq + bash logic AS SHIPPED —
 * mirrors the multi-hop-eval.test.ts "shell out as shipped" pattern. The fake
 * gh honours `-q` via real jq, so the script's exact filter expressions run.
 *
 * Run: `bun test scripts/pr-finish.test.ts`  (also a step in CI regression-gates).
 */
import { test, expect, beforeAll, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPTS = import.meta.dirname;
const PR_FINISH = join(SCRIPTS, "pr-finish.sh");

// --- fake gh -----------------------------------------------------------------
// Serves only `gh pr checks <pr> [...]`. Canned check-states come from
// $FAKE_CHECKS_FILE (a JSON array of {state}). --watch → immediate success;
// --json → emit canned (optionally filtered by -q via real jq); plain →
// non-empty iff checks exist (matches real gh's empty-when-no-checks behavior,
// which the registration poll's `-z` test depends on).
const FAKE_GH = [
  "#!/usr/bin/env bash",
  "# fake gh for pr-finish.test.ts — serves `gh pr checks <pr> [...]",
  'if [[ "${1:-}" != "pr" || "${2:-}" != "checks" ]]; then echo "fake-gh unsupported: $*" >&2; exit 1; fi',
  'want_json=0; want_watch=0; q=""; prev=""',
  'for a in "$@"; do',
  '  [[ "$a" == "--json" ]] && want_json=1',
  '  [[ "$a" == "--watch" ]] && want_watch=1',
  '  [[ "$prev" == "-q" || "$prev" == "--jq" ]] && q="$a"',
  '  prev="$a"',
  "done",
  '[[ "$want_watch" == "1" ]] && exit 0',
  'data="$(cat "${FAKE_CHECKS_FILE:-/dev/null}")"',
  'if [[ "$want_json" == "1" ]]; then',
  '  if [[ -n "$q" ]]; then printf \'%s\' "$data" | jq "$q"; else printf \'%s\' "$data"; fi',
  "else",
  '  [[ "$data" != "[]" ]] && printf \'fake-check\\tSUCCESS\\turl\\n\'',
  "fi",
  "",
].join("\n");

let binDir = "";
let checksFile = "";
let funcsFile = "";

beforeAll(() => {
  if (!existsSync(PR_FINISH)) throw new Error(`pr-finish.sh not found at ${PR_FINISH}`);
  // Extract ci_running() + wait_ci() from the REAL script ONCE into a file.
  // (Sourcing a real file is robust; `source <(sed ...)` process substitution
  // failed to define the functions under Bun.spawn's env in early dogfooding.)
  funcsFile = join(tmpdir(), `prf-funcs-${process.pid}-${crypto.randomUUID()}.sh`);
  execFileSync("bash", [
    "-c",
    `sed -n '/^ci_running()/,/^}/p;/^wait_ci()/,/^}/p' "${PR_FINISH}" > "${funcsFile}"`,
  ]);
  if (!existsSync(funcsFile) || statSync(funcsFile).size === 0) {
    throw new Error("sed extraction of ci_running/wait_ci produced an empty file");
  }
});

afterAll(() => {
  try {
    rmSync(funcsFile);
  } catch {
    // best-effort cleanup
  }
});

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "prf-"));
  const ghPath = join(binDir, "gh");
  writeFileSync(ghPath, FAKE_GH);
  chmodSync(ghPath, 0o755);
  checksFile = join(binDir, "checks.json");
});

afterEach(() => rmSync(binDir, { recursive: true, force: true }));

function setChecks(states: string[]): void {
  writeFileSync(checksFile, JSON.stringify(states.map((state) => ({ state }))));
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Source ci_running() + wait_ci() (extracted to funcsFile) then run `call`. */
async function runFn(call: string): Promise<RunResult> {
  const snippet = ["set +e", `source "${funcsFile}"`, call].join("\n");
  const proc = Bun.spawn(["bash", "-c", snippet], {
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      FAKE_CHECKS_FILE: checksFile,
      CHECKS_REGISTER_TIMEOUT: "0", // registration poll is instant in tests
      HOME: process.env.HOME,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

/** ci_running → true if any check is non-terminal (running/pending). */
async function ciRunning(): Promise<boolean> {
  const r = await runFn("if ci_running X; then echo RUNNING; else echo IDLE; fi");
  if (r.code !== 0) throw new Error(`ci_running shell failed:\n${r.stderr}`);
  return r.stdout.trim() === "RUNNING";
}

/** wait_ci exit code for (required?). */
async function waitCi(required: boolean): Promise<number> {
  const r = await runFn(`wait_ci X ${required}; echo "EXIT:$?"`);
  const m = r.stdout.match(/EXIT:(\d+)/);
  if (!m) throw new Error(`wait_ci produced no EXIT marker:\n${r.stdout}\n${r.stderr}`);
  return Number(m[1]);
}

// --- ci_running: terminal vs non-terminal classification ---------------------

test("ci_running: all-SUCCESS → IDLE", async () => {
  setChecks(["SUCCESS", "SUCCESS"]);
  expect(await ciRunning()).toBe(false);
});

test("ci_running: PENDING → RUNNING", async () => {
  setChecks(["SUCCESS", "PENDING"]);
  expect(await ciRunning()).toBe(true);
});

test("ci_running: QUEUED → RUNNING", async () => {
  setChecks(["QUEUED"]);
  expect(await ciRunning()).toBe(true);
});

test("ci_running: FAILURE → IDLE (terminal)", async () => {
  setChecks(["FAILURE"]);
  expect(await ciRunning()).toBe(false);
});

test("ci_running: CANCELLED → IDLE (terminal)", async () => {
  setChecks(["CANCELLED"]);
  expect(await ciRunning()).toBe(false);
});

test("ci_running: TIMED_OUT → IDLE (terminal)", async () => {
  setChecks(["TIMED_OUT"]);
  expect(await ciRunning()).toBe(false);
});

test("ci_running: empty → IDLE (no checks)", async () => {
  setChecks([]);
  expect(await ciRunning()).toBe(false);
});

test("ci_running: mixed FAILURE+PENDING → RUNNING (a pending check is still in flight)", async () => {
  setChecks(["FAILURE", "PENDING"]);
  expect(await ciRunning()).toBe(true);
});

// --- wait_ci: aggregate gate (merge decision) --------------------------------

test("wait_ci(false): all-SUCCESS → green (exit 0)", async () => {
  setChecks(["SUCCESS", "SUCCESS"]);
  expect(await waitCi(false)).toBe(0);
});

test("wait_ci(false): NEUTRAL + SKIPPED count as passing (exit 0)", async () => {
  setChecks(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  expect(await waitCi(false)).toBe(0);
});

test("wait_ci(false): one FAILURE → gate fails (exit 1)", async () => {
  setChecks(["SUCCESS", "FAILURE"]);
  expect(await waitCi(false)).toBe(1);
});

test("wait_ci(false): CANCELLED → gate fails (exit 1)", async () => {
  setChecks(["CANCELLED"]);
  expect(await waitCi(false)).toBe(1);
});

test("wait_ci(false): TIMED_OUT → gate fails (exit 1)", async () => {
  setChecks(["TIMED_OUT"]);
  expect(await waitCi(false)).toBe(1);
});

// --- wait_ci: registration poll + required modes (empty checks) --------------

test("wait_ci(false): no checks register → assumes no-CI, proceeds (exit 0)", async () => {
  setChecks([]);
  expect(await waitCi(false)).toBe(0);
});

test("wait_ci(true): no checks re-register → ABORT (base-update race guard)", async () => {
  setChecks([]);
  expect(await waitCi(true)).toBe(1);
});
