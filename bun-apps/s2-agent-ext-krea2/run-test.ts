#!/usr/bin/env bun
/**
 * run-test.ts — tiered test launcher for s2-agent-ext-krea2.
 *
 * Portable Bun twin of the retired run-test.sh (deleted once the golden-parity
 * test went green). Same flags, same stdout shape (ANSI colors included), same
 * exit codes — byte-proven by bun-apps/tests/run-test-launchers-parity.test.ts.
 * The script name inside the banner is preserved VERBATIM as "run-test.sh" —
 * it is a display name within the parity contract, not a call site.
 *
 *   quick (default) — the package's canonical `bun run test` (the .sh ran a
 *                      bare `bun test`; the canonical script is the source of
 *                      truth for the per-package quirks the bare form gets
 *                      wrong — see CLAUDE.md).
 *   full            — quick + extension-contract.test.ts re-asserted standalone.
 *                    The contract assertion is the .sh's SINGLE-FILE form
 *                    ("bun test <file>"), by design: the canonical mandate
 *                    covers the quick/full BASE runner only (see the
 *                    runContract() comment).
 * USAGE (from anywhere):
 *   bun bun-apps/s2-agent-ext-krea2/run-test.ts              # = quick
 *   bun bun-apps/s2-agent-ext-krea2/run-test.ts full
 *   bun bun-apps/s2-agent-ext-krea2/run-test.ts --list       # print the tier table, exit 0
 *   bun bun-apps/s2-agent-ext-krea2/run-test.ts quick --bail # extra flags are forwarded
 *                             to the test runner (quick tier only, exactly like
 *                             the .sh; the full tier's contract step is not).
 *
 * MEASURED 2026-08-23: a word that is not a tier lands in EXTRA and is
 * forwarded to `bun run test` — the "unknown tier → exit 2" branch is DEAD
 * CODE from the CLI in this launcher (no non-tier value can ever reach TIER;
 * the sibling effort-stack launcher, s2-agent-ext-power-tool, reaches its
 * exit 2 via --effort=). The check is kept for structural parity with the
 * .sh. Exit code is 0 iff every selected tier passed, 1 on any failure.
 */
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG = "s2-agent-ext-krea2";
// extension-contract.test.ts re-asserted standalone (the `full` tier).
const CONTRACT_TEST = "src/extension-contract.test.ts";
const LOG_PATH = `/tmp/${PKG}-runtest.log`;

// ── colors (identical to the .sh) ─────────────────────────────────────────
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;

// ── parse args — last tier assignment wins; unknown words → EXTRA ──────────
let tier = "quick";
let list = false;
const extra: string[] = [];
for (const arg of process.argv.slice(2)) {
  if (arg === "-l" || arg === "--list") list = true;
  else if (arg === "quick" || arg === "full") tier = arg;
  else extra.push(arg);
}

function printList(): void {
  process.stdout.write(
    `${Y(`${PKG} run-test.sh — tiers`)}:\n` +
      `  ${G("quick")}  bun test (this package's existing test command)  ${Y("[default]")}\n` +
      `  ${G("full")}   quick + extension-contract.test.ts re-asserted standalone\n`,
  );
}

if (list) {
  printList();
  process.exit(0);
}

if (tier !== "quick" && tier !== "full") {
  console.error(`${R("error")}: unknown tier '${tier}' (want: quick|full)`);
  process.exit(2);
}

// ── tier runners ──────────────────────────────────────────────────────────
// A failing tier reports instead of aborting the run — `overall` folds. The
// runner is the package's CANONICAL `bun run test`, never a bare `bun test`.
let overall = 0;

// Per-run log; each step() truncates it, exactly like `>/tmp/<pkg>-runtest.log`.
let logFd: number | null = null;

function runBun(args: string[]): number {
  const r = spawnSync("bun", ["run", "--silent", ...args], {
    cwd: SCRIPT_DIR,
    stdio: ["ignore", logFd!, logFd!],
  });
  return r.status ?? 1;
}

function runQuick(): number {
  return runBun(["test", ...extra]);
}

function runContract(): number {
  // The .sh's single-file assertion, verbatim: "bun test <file>" — NOT through
  // `bun run test`, which appends the path to the canonical script: for the
  // scope-baked canonicals (knowledge-card, obsidian) bun unions the
  // positionals and re-runs the whole package suite as the "contract" step.
  // The canonical-`bun run test` mandate covers the quick/full BASE runner.
  const r = spawnSync("bun", ["test", CONTRACT_TEST], {
    cwd: SCRIPT_DIR,
    stdio: ["ignore", logFd!, logFd!],
  });
  return r.status ?? 1;
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

console.log(`${Y(`▶ ${PKG} run-test.sh — tier=${tier}`)}`);
if (tier === "quick") {
  step("quick", runQuick);
} else {
  step("quick", runQuick);
  step("contract (standalone)", runContract);
}

console.log("");
if (overall === 0) {
  console.log(`${G(`✓ tier=${tier} passed`)}`);
} else {
  console.log(`${R(`✗ tier=${tier} had failures (see above)`)}`);
}
process.exit(overall);
