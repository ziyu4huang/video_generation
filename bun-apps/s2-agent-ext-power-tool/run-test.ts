#!/usr/bin/env bun
/**
 * run-test.ts — multi-effort-level test launcher for s2-agent-ext-power-tool.
 *
 * Portable Bun twin of the retired run-test.sh (deleted once the golden-parity
 * test went green). Same flags, same stdout shape (ANSI colors included), same
 * exit codes — byte-proven by bun-apps/tests/run-test-launchers-parity.test.ts.
 * The script name inside the banner is preserved VERBATIM as "run-test.sh" —
 * it is a display name within the parity contract, not a call site.
 *
 * Mirrors bun-apps/s2-agent/run-test.sh's tier names, the .sh's effort stack
 * included. power-tool has no build/deploy step of its own — tiers map onto
 * its L0 (unit) / L2 (opt-in real-CLI + real-model) layers (see
 * src/__tests__/l2-e2e.test.ts header). There is no standalone L1
 * (deterministic subprocess, no model): invoking a tool through the real CLI
 * always calls the configured LLM, so `high` and `full` run the same suite and
 * differ only in skip-vs-fail on blocked services (PI_REQUIRE_L2).
 *
 *   quick    (0)   unit only, no typecheck.            DEFAULT @ runtime: medium
 *   medium   (1)   + typecheck (tsc --noEmit). DEFAULT.
 *   high     (2)   + PI_RUN_L2=1 (blocked services SKIP).
 *   readonly (2.5) PI_RUN_L2=1, l2-e2e.test.ts ONLY (skip allowed). Opt-in tier.
 *   full     (3)   quick + medium + PI_RUN_L2=1 PI_REQUIRE_L2=1
 *                  (blocked services FAIL, not skip).
 *
 * USAGE (from anywhere):
 *   bun bun-apps/s2-agent-ext-power-tool/run-test.ts             # = medium
 *   bun bun-apps/s2-agent-ext-power-tool/run-test.ts quick
 *   bun bun-apps/s2-agent-ext-power-tool/run-test.ts readonly
 *   bun bun-apps/s2-agent-ext-power-tool/run-test.ts --effort=medium
 *   bun bun-apps/s2-agent-ext-power-tool/run-test.ts --list      # tier table
 *   bun bun-apps/s2-agent-ext-power-tool/run-test.ts medium --bail  # → test runner
 *
 * MEASURED 2026-08-23: (1) `--effort=bogus` is the reachable unknown-effort →
 * exit 2 path (bare unrecognized words land in EXTRA and are forwarded to the
 * test runner, exactly like the .sh — `bogus` alone runs medium with a bogus
 * filter). (2) a trailing `--effort` with no value HUNG the .sh (bash `shift
 * 2` with one positional left loops forever) — this .ts treats it as
 * `--effort=` (empty) and falls into the same unknown-effort exit 2 path.
 */
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG = "s2-agent-ext-power-tool";
const L2_TEST = "src/__tests__/l2-e2e.test.ts";
const LOG_PATH = "/tmp/power-tool-runtest.log";

// ── colors (identical to the .sh) ─────────────────────────────────────────
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;

// ── parse args — last assignment wins, exactly like the .sh's single
// EFFORT variable; numeric aliases normalize post-loop ─────────────────────
let effort = "medium";
let list = false;
const extra: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg.startsWith("--effort=")) {
    effort = arg.slice("--effort=".length);
  } else if (arg === "--effort") {
    // .sh: EFFORT="${2:-}"; shift 2 — with no value left, that `shift 2`
    // errored and the loop re-consumed `--effort` forever (measured hang).
    // Here: no value = empty effort → the unknown-effort exit-2 path below.
    effort = args[i + 1] ?? "";
    i++;
  } else if (arg === "-l" || arg === "--list") {
    list = true;
  } else if (
    arg === "quick" || arg === "medium" || arg === "high" || arg === "readonly" || arg === "full" ||
    arg === "0" || arg === "1" || arg === "2" || arg === "3"
  ) {
    effort = arg;
  } else {
    extra.push(arg);
  }
}
if (effort === "0") effort = "quick";
else if (effort === "1") effort = "medium";
else if (effort === "2") effort = "high";
else if (effort === "3") effort = "full";

function printList(): void {
  process.stdout.write(
    `${Y(`${PKG} run-test.sh — effort tiers`)}:\n\n` +
      `  ${G("quick")}    ${D("~1s")}     unit only, no typecheck\n` +
      `  ${G("medium")}   ${D("~5s")}     + typecheck (tsc --noEmit)  ${Y("[default]")}\n` +
      `  ${G("high")}     ${D("varies")}  + PI_RUN_L2=1 (blocked services SKIP)\n` +
      `  ${G("readonly")} ${D("varies")}  PI_RUN_L2=1, l2-e2e.test.ts ONLY (skip allowed)\n` +
      `  ${G("full")}     ${D("varies")}  quick + medium + PI_RUN_L2=1 PI_REQUIRE_L2=1 (blocked services FAIL)\n\n` +
      `Env gates l2-e2e.test.ts reads:\n` +
      `  PI_RUN_L2=1      enable L2 (spawns real CLI + real LM Studio model)  (high+)\n` +
      `  PI_REQUIRE_L2=1  blocked services FAIL instead of SKIP               (full)\n` +
      `  PI_L2_MODEL      override the LM Studio model (default: google/gemma-4-12b)\n`,
  );
}

if (list) {
  printList();
  process.exit(0);
}

if (effort !== "quick" && effort !== "medium" && effort !== "high" && effort !== "readonly" && effort !== "full") {
  console.error(`${R("error")}: unknown effort '${effort}' (want: quick|medium|high|readonly|full)`);
  console.error("try: ./run-test.sh --list");
  process.exit(2);
}

// ── tier runners ──────────────────────────────────────────────────────────
// A failing tier reports instead of aborting the run — `overall` folds.
// Test steps use the package's CANONICAL `bun run test`, never a bare
// `bun test`; the typecheck step uses the canonical `bun run typecheck`.
// The .sh exported/unset PI_RUN_L2 / PI_REQUIRE_L2 in place — bash exports
// persist for the whole script, so one shared env object mutated in place is
// exactly that semantics for the sequence of child steps.
let overall = 0;
const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };

// Per-run log; each step() truncates it, exactly like `>/tmp/power-tool-runtest.log`.
let logFd: number | null = null;

function runBun(args: string[]): number {
  // --silent: don't let `bun run` echo the forwarded command
  // (`$ bun test ...`) into the log — the .sh's log was the bare command's
  // output only.
  const r = spawnSync("bun", ["run", "--silent", ...args], {
    cwd: SCRIPT_DIR,
    env: childEnv,
    stdio: ["ignore", logFd!, logFd!],
  });
  return r.status ?? 1;
}

function runUnit(): number {
  delete childEnv.PI_RUN_L2;
  delete childEnv.PI_REQUIRE_L2;
  return runBun(["test", ...extra]);
}

function runTypecheck(): number {
  return runBun(["typecheck"]);
}

function runL2(): number {
  delete childEnv.PI_REQUIRE_L2;
  childEnv.PI_RUN_L2 = "1";
  return runBun(["test", ...extra]);
}

function runL2Only(): number {
  delete childEnv.PI_REQUIRE_L2;
  childEnv.PI_RUN_L2 = "1";
  return runBun(["test", L2_TEST, ...extra]);
}

function runL2Strict(): number {
  childEnv.PI_RUN_L2 = "1";
  childEnv.PI_REQUIRE_L2 = "1";
  return runBun(["test", ...extra]);
}

// Run a named step, capture rc + elapsed, color the summary line, fold overall.
function step(name: string, fn: () => number): void {
  if (logFd !== null) closeSync(logFd);
  logFd = openSync(LOG_PATH, "w");
  const start = Date.now();
  const rc = fn();
  closeSync(logFd);
  logFd = null;
  const elapsed = Math.floor((Date.now() - start) / 1000);
  if (rc === 0) {
    console.log(`${G("✓")} ${name}  ${D(`(${elapsed}s)`)}`);
  } else {
    console.log(`${R("✗")} ${name}  ${D(`(${elapsed}s)`)}`);
    overall = 1;
    // Surface the tail of a failed step — exact
    // `sed 's/^/      /' <log> | tail -n 25 >&2` semantics (a final newline
    // terminates the last line; sed on an empty file emits nothing).
    const log = readFileSync(LOG_PATH, "utf8");
    if (log.length > 0) {
      const endsNL = log.endsWith("\n");
      const body = endsNL ? log.slice(0, -1) : log;
      const lines = body.split("\n").slice(-25).map((l) => `      ${l}`);
      process.stderr.write(`${lines.join("\n")}${endsNL ? "\n" : ""}`);
    }
  }
}

console.log(`${Y(`▶ ${PKG} run-test.sh — effort=${effort}`)}`);
if (effort === "quick") {
  step("unit (quick)", runUnit);
} else if (effort === "medium") {
  step("unit (quick)", runUnit);
  step("typecheck (medium)", runTypecheck);
} else if (effort === "high") {
  step("unit (quick)", runUnit);
  step("typecheck (medium)", runTypecheck);
  step("unit + L2 e2e (high, skip-on-blocked)", runL2);
} else if (effort === "readonly") {
  step("L2 e2e only (readonly, skip-on-blocked)", runL2Only);
} else {
  step("unit (quick)", runUnit);
  step("typecheck (medium)", runTypecheck);
  step("unit + L2 e2e (full, FAIL-on-blocked)", runL2Strict);
}

console.log("");
if (overall === 0) {
  console.log(`${G(`✓ effort=${effort} passed`)}`);
} else {
  console.log(`${R(`✗ effort=${effort} had failures (see above)`)}`);
}
process.exit(overall);
