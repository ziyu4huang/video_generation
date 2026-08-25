#!/usr/bin/env bun
/**
 * run-test.ts — multi-effort-level test launcher for s2-agent.
 *
 * Portable Bun twin of the retired scripts/run-test.sh (deleted once the
 * golden-parity test went green). Same flags, same stdout shape (ANSI colors
 * included), same exit codes — byte-proven by tests/run-test-parity.test.ts.
 *
 * Effort is a MONOTONIC stack: each level runs everything the lower one does,
 * plus more. Cost is driven by the build + deploy, not the tests themselves.
 *
 *   quick   (0)  unit only (pure fn + import-time smoke).                  ~90s
 *   medium  (1)  + the s2-agent package suite, incl. the run.sh/s2-agent.sh
 *                 launcher e2e (symlink resolution, entry-mode detection,
 *                 --upgrade passthrough). DEFAULT.
 *   smoke    (2)  + LIVE LLM check: boots the real launcher in print mode
 *                  against the CI/E2E lane deepseek/deepseek-v4-flash-vision-exp
 *                  (2026-08-24 directive: LM Studio is out of the shared
 *                  lanes — GPU contention pushed gates past watchdogs).
 *                  Skips (passes) when DEEPSEEK_API_KEY is unset; a live
 *                  provider error fails. Opt-in tier; also folded into full
 *                  (skips when the key is unset).
 *   full    (3)  + smoke + sibling pi-* unit baseline (whole stack).
 *
 * The `high` and `readonly` tiers are GONE. They existed to deploy the
 * bundle/snapshot/standalone modes and run the e2e suites that asserted against
 * them; those modes and suites were retired with the deploy-architecture
 * consolidation. The deployed artifact's e2e now lives in
 * s2-agent-ext-devops/tests/deploy-probe-e2e.test.ts, gated from CI by
 * scripts/check-deploy-e2e.sh.
 *
 * USAGE (from anywhere):
 *   bun scripts/run-test.ts            # = medium
 *   bun scripts/run-test.ts quick      # pre-commit
 *   bun scripts/run-test.ts smoke      # live check vs deepseek only
 *   bun scripts/run-test.ts full       # whole stack (incl. smoke)
 *   bun scripts/run-test.ts --effort=medium
 *   bun scripts/run-test.ts --list     # print the tier table, exit 0
 *   bun scripts/run-test.ts medium --bail   # extra flags forwarded to `bun test`
 *
 * Env:
 *   PI_AGENT_E2E  the launcher-symlink-resolution e2e block gate (medium+ sets
 *                 it to 1; quick unsets it; smoke passes the caller's through).
 *
 * Nothing here builds a deploy any more — PI_AGENT_E2E_NO_BUILD is gone with the
 * bundle it referred to. Exit code is 0 iff every selected tier/package passed,
 * 1 on any failure, 2 on an unknown `--effort=` value.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// This script lives in bun-apps/s2-agent-ext-devops/scripts/, but the package it
// drives is bun-apps/s2-agent — resolve it once here.
const PI_AGENT_DIR = resolve(SCRIPT_DIR, "../../s2-agent");

// ── sibling stack-health baseline (the `full` tier) ───────────────────────
// Sibling bun-apps/<pkg> packages whose suites run as part of `full`. These are
// NAMES, not paths, so nothing typechecks them — this list previously read
// `pi-obsidian pi-knowledge-card`, directories that have never existed, and a
// skip-if-absent branch swallowed the miss for months while reporting green.
//
// `--list-siblings` exists so the list has an EXECUTOR:
// bun-apps/tests/ci-workflow-references.test.ts shells out to it and asserts
// every name resolves to a real bun-apps/<pkg>/package.json. Keep that flag
// working — it is the only thing standing between this list and silent rot.
const SIBLING_PKGS = [
	"s2-agent-ext-obsidian",
	"s2-agent-ext-knowledge-card",
	"s2-agent-ext-file2md",
];

// ── colors ────────────────────────────────────────────────────────────────
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;

// ── parse args ────────────────────────────────────────────────────────────
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
		// errored and the loop re-consumed `--effort` forever. Here: no value
		// = empty effort → the unknown-effort exit-2 path below.
		effort = args[i + 1] ?? "";
		i++;
	} else if (arg === "-l" || arg === "--list") {
		list = true;
	} else if (arg === "--list-siblings") {
		// Machine-readable: one sibling package name per line. Consumed by the
		// CI-reference guard test; keep the output one-bare-name-per-line.
		console.log(SIBLING_PKGS.join("\n"));
		process.exit(0);
	} else if (
		arg === "quick" || arg === "medium" || arg === "smoke" || arg === "full" ||
		arg === "0" || arg === "1" || arg === "2" || arg === "3"
	) {
		effort = arg;
	} else {
		extra.push(arg);
	}
}
// normalize numeric aliases — last assignment wins, exactly like the .sh's
// single EFFORT variable
if (effort === "0") effort = "quick";
else if (effort === "1") effort = "medium";
else if (effort === "2") effort = "smoke";
else if (effort === "3") effort = "full";

function printList(): void {
	process.stdout.write(
		`${Y("s2-agent run-test.sh — effort tiers (each ⊇ the one above)")}:\n\n` +
			`  ${G("quick")}   ${D("~0.2s")}  unit only (pure fn + import-time smoke)\n` +
			`  ${G("medium")}  ${D("~7s")}    + the s2-agent package suite incl. the launcher e2e  ${Y("[default]")}\n` +
			`  ${G("smoke")}   ${D("~30s")}   LIVE LLM check vs deepseek/deepseek-v4-flash-vision-exp\n` +
			`                            (the CI/E2E lane, 2026-08-24). Skips when DEEPSEEK_API_KEY\n` +
			`                            is unset; a live provider error fails. Also folded into ${G("full")}.\n` +
			`  ${G("full")}    ${D("~40s")}   + smoke + sibling pi-* unit baseline (whole stack)\n\n` +
			`Env gates the e2e test files read:\n` +
			`  PI_AGENT_E2E=1          enable the launcher symlink-resolution block (medium+)\n\n` +
			`The deployed artifact's own e2e is a separate gate:\n` +
			`  bash scripts/check-deploy-e2e.sh\n`,
	);
}

if (list) {
	printList();
	process.exit(0);
}

if (effort !== "quick" && effort !== "medium" && effort !== "smoke" && effort !== "full") {
	console.error(`${R("error")}: unknown effort '${effort}' (want: quick|medium|smoke|full)`);
	console.error("try: ./run-test.sh --list");
	process.exit(2);
}

// ── tier runners ──────────────────────────────────────────────────────────
// Each selects env, runs `bun test` (extra flags forwarded), returns its exit
// code. A failing tier reports instead of aborting the run — `overall` folds.
let overall = 0;

// child env: the .sh exported PI_AGENT_E2E=1 inside run_patches and `unset`
// it inside run_unit — bash exports persist for the whole script, so a `full`
// run's SIBLING `bun run test` children inherit PI_AGENT_E2E=1 too. One shared
// env object mutated in place is exactly that semantics.
const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };

// Per-run log; each step() truncates it, exactly like `>/tmp/s2-agent-runtest.log`.
const LOG_PATH = "/tmp/s2-agent-runtest.log";
let logFd: number | null = null;

function runBunTest(cwd: string, args2: string[]): number {
	const r = spawnSync("bun", args2, {
		cwd,
		env: childEnv,
		stdio: ["ignore", logFd!, logFd!],
	});
	return r.status ?? 1;
}

function runUnit(): number {
	// quick baseline: the one E2E-gated block auto-skips (no PI_AGENT_E2E).
	delete childEnv.PI_AGENT_E2E;
	return runBunTest(PI_AGENT_DIR, ["test", ...extra]);
}

function runPatches(): number {
	// Same suite as quick, with PI_AGENT_E2E=1 so the launcher's
	// symlink-resolution block (which spawns the real src/cli.ts) runs too.
	childEnv.PI_AGENT_E2E = "1";
	return runBunTest(PI_AGENT_DIR, ["test", ...extra]);
}

// LIVE LLM smoke test. Boots the REAL launcher (`run.sh`) in print mode
// against the CI/E2E lane deepseek/deepseek-v4-flash-vision-exp (operator
// directive 2026-08-24, same lane as e2e-core-tool-roundtrip: LM Studio is
// out of the shared lanes — its GPU contention pushed gates past watchdogs).
// Opt-in tier — run via `bun run-test.ts smoke`; also folded into `full`.
// Skips (rc 0) when DEEPSEEK_API_KEY is unset (an environment condition, not
// a repo bug). A live provider error (bad key, API down) FAILS the step — the
// same posture as the roundtrip e2e's non-fast failures. Sets smokeSkipped so
// the caller can print the skip notice (step() only surfaces the log on
// failure).
const SMOKE_MODEL = "deepseek/deepseek-v4-flash-vision-exp";
let smokeSkipped = false;

function runSmoke(): number {
	if (!process.env.DEEPSEEK_API_KEY) {
		smokeSkipped = true;
		return 0;
	}
	// A reachable-key case can only be proven live; the spinner-not-`-f`-style
	// verbosity is silenced the way the .sh did with `>/dev/null 2>&1`, and
	// run.sh's exit code IS this step's exit code. The full `provider/model`
	// id makes the spawn immune to a user-level defaultProvider hijack.
	return (
		spawnSync(resolve(PI_AGENT_DIR, "run.sh"), [
			"--model", SMOKE_MODEL, "--no-session", "-p", "hi",
		], { cwd: PI_AGENT_DIR, env: childEnv, stdio: "ignore" }).status ?? 1
	);
}

// step() prints the ✓/✗ line via the summary, then the skip notice to the
// terminal (step captures all output into the log, which is only surfaced on
// failure — a silent skip would read as a pass).
function smokeStep(): void {
	step("live deepseek smoke (smoke)", runSmoke);
	if (smokeSkipped) {
		console.log(`${Y("· smoke skipped")} — DEEPSEEK_API_KEY not set (the smoke lane is deepseek/deepseek-v4-flash-vision-exp per the 2026-08-24 directive)`);
	}
}

// Sibling extension suites for the "full" stack-health check.
//
// Always the package's CANONICAL `bun run test` script, never a bare `bun test`:
// each of these encodes a flag the bare form gets wrong (file2md needs --isolate
// or 12 mock-leak false failures appear; obsidian scopes to extensions/__tests__/).
// See CLAUDE.md — "Always run a package's canonical `bun run test` script".
//
// An absent directory is a HARD FAILURE, not a skip. This loop previously named
// `pi-obsidian` / `pi-knowledge-card` — directories that have never existed (the
// real ones are `s2-agent-ext-*`) — and a `return 0` skip swallowed both, so the
// "sibling stack-health baseline" silently tested one package instead of three
// while reporting green. bun-apps/tests/ci-workflow-references.test.ts now pins
// these names; if one moves again, that guard fails before this loop runs.
function runPkgUnit(pkg: string): number {
	const d = resolve(PI_AGENT_DIR, "..", pkg);
	if (!existsSync(d)) {
		writeSync(logFd!, `${R(`✗ ${pkg}: bun-apps/${pkg}/ does not exist`)}\n`);
		writeSync(logFd!, `  the sibling list in this script names a package that is gone or renamed.\n`);
		return 1;
	}
	return runBunTest(d, ["run", "test", ...extra]);
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
		// Surface the tail of a failed step so the failure isn't hidden —
		// exact `sed 's/^/      /' <log> | tail -n 60` semantics (a final
		// newline terminates the last line; sed on an empty file emits nothing).
		const log = readFileSync(LOG_PATH, "utf8");
		if (log.length > 0) {
			const endsNL = log.endsWith("\n");
			const body = endsNL ? log.slice(0, -1) : log;
			const lines = body.split("\n").slice(-60).map((l) => `      ${l}`);
			process.stderr.write(`${lines.join("\n")}${endsNL ? "\n" : ""}`);
		}
	}
}

console.log(`${Y(`▶ s2-agent run-test.sh — effort=${effort}`)}`);

if (effort === "quick") {
	step("unit (quick)", runUnit);
} else if (effort === "medium") {
	step("unit + patch e2e (medium)", runPatches);
} else if (effort === "smoke") {
	smokeStep();
} else if (effort === "full") {
	step("unit + patch e2e (medium)", runPatches);
	console.log(`${Y("▶ live LLM smoke (skips when DEEPSEEK_API_KEY is unset)")}`);
	smokeStep();
	console.log(`${Y("▶ sibling stack-health baseline")}`);
	for (const pkg of SIBLING_PKGS) {
		step(`${pkg} unit`, () => runPkgUnit(pkg));
	}
}

console.log("");
if (overall === 0) {
	console.log(`${G(`✓ effort=${effort} passed`)}`);
} else {
	console.log(`${R(`✗ effort=${effort} had failures (see above)`)}`);
}
process.exit(overall);
