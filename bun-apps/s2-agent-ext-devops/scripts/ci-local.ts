#!/usr/bin/env bun
/**
 * ci-local.ts — portable Bun twin of the retired scripts/ci-local.sh (deleted
 * once the golden-parity test went green). Runs the CI `tests` matrix and the
 * `regression-gates` job locally, parsed LIVE from
 * .github/workflows/ci.yml.disabled — the repo's only executor of that
 * specification (GitHub Actions is disabled here). Same flags, same stdout
 * shape (ANSI colors included when stdout is a TTY), same exit codes
 * (0 pass / 1 failure / 2 usage), proven byte-for-byte by
 * tests/ci-local-parity.test.ts.
 *
 * The long doc printed by `-h`/`--help` is the HELP constant below — one
 * copy, the way the retired .sh printed its own header via
 * `sed -n '2,60p' "$0"`. Keep it in that form; the parity test derives its
 * golden from the old script's header by the naming substitutions.
 */
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// This script lives in bun-apps/s2-agent-ext-devops/scripts/ — repo root is
// three levels up, exactly like the .sh's `SCRIPT_DIR/../../..`.
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");

// The workflow the matrix is parsed OUT OF — never a hand-maintained copy of
// the matrix here (the ONE DESIGN RULE, see HELP below). src/ci-matrix.ts
// exports the same constant (CI_WORKFLOW_PATH); this script stays standalone
// (no src/ import), so the path is duplicated deliberately — both point at the
// same file and both are pinned by tests (ci-workflow-references.test.ts).
const WORKFLOW = ".github/workflows/ci.yml.disabled";
const WORKFLOW_PATH = resolve(REPO_ROOT, WORKFLOW);

// ── help ────────────────────────────────────────────────────────────────────
const HELP = [
	"# ci-local.ts — run the CI `tests` matrix locally, parsed live from the workflow.",
	"#",
	"# WHY THIS EXISTS",
	"#   GitHub Actions is disabled in this repo (.github/workflows/ holds only",
	"#   ci.yml.disabled, and `main` carries no branch-protection rule — see",
	"#   .github/CI.md). The matrix is therefore a SPECIFICATION that nothing",
	"#   executes. This script is the thing that executes it.",
	"#",
	"# THE ONE DESIGN RULE",
	"#   The package/command list is PARSED OUT OF .github/workflows/ci.yml.disabled",
	"#   at runtime. This script deliberately carries NO copy of the matrix. A second",
	"#   hand-maintained copy would drift from the first, and spec-vs-runner drift is",
	"#   the exact failure mode this repo keeps hitting (a stale dist/, a build.ts",
	"#   that never existed, a required check for a deleted package). If you add a",
	"#   matrix row, this script picks it up with no edit here — verify with --list.",
	"#",
	"# WHAT IT COVERS",
	"#   Two jobs, each parsed live, selected by flag:",
	"#     (default)  the `tests` matrix — every `- { package: X, test-cmd: Y }` row,",
	"#                run as `Y` inside bun-apps/X with CI=true (the same env var",
	"#                GitHub Actions sets, which the machine-coupled tests skip on).",
	"#     --gates    the `regression-gates` job — every `run:` step, in its own",
	"#                working-directory. That job is where EVERY structural guard",
	"#                lives (dep-direction, seam, routing, config-parity, CI-workflow",
	"#                references, package-script runnability, the portability and",
	"#                determinism audits). Before --gates existed, the guards were",
	"#                themselves a class with no local executor — precisely the",
	"#                failure they exist to prevent. The whole job runs in ~6s.",
	"#",
	"# WHAT IT DOES **NOT** COVER — a green run here is NOT a green CI:",
	"#   - extension-contract      (bun test src/__tests__/extension-contract.test.ts)",
	"#   - deploy-verify           (bun-apps/s2-agent-ext-devops/scripts/run-test.ts full — the high/readonly tiers are GONE)",
	"#   - compile-verify          (bun run deploy:exe + binary smokes)",
	"#   - clean-launch-self-heal  (clean-checkout check-deps.ts self-heal)",
	"#   - determinism-spotcheck   (3x the flake-prone subset; run it directly via",
	"#                              scripts/test-determinism-spotcheck.sh)",
	"#   - the changed_packages smart-routing filter (this script runs EVERYTHING,",
	"#     like push-to-main does, not the affected subset)",
	"#   Nor does it install deps: run `( cd bun-apps && bun install )` first if the",
	"#   tree is fresh.",
	"#",
	"# USAGE",
	"#   bun bun-apps/s2-agent-ext-devops/scripts/ci-local.ts --list             # print the parsed matrix, run nothing",
	"#   bun bun-apps/s2-agent-ext-devops/scripts/ci-local.ts --tsv              # machine-readable \"<pkg>\\t<cmd>\" lines",
	"#   bun bun-apps/s2-agent-ext-devops/scripts/ci-local.ts                    # run every matrix entry, sequentially",
	"#   bun bun-apps/s2-agent-ext-devops/scripts/ci-local.ts --only s2-agent    # run a subset (comma-separated)",
	"#   bun bun-apps/s2-agent-ext-devops/scripts/ci-local.ts --only a,b --list  # preview just that subset",
	"#   bun bun-apps/s2-agent-ext-devops/scripts/ci-local.ts --gates            # run the regression-gates job instead",
	"#   bun bun-apps/s2-agent-ext-devops/scripts/ci-local.ts --gates --list     # preview it",
	"#   bun bun-apps/s2-agent-ext-devops/scripts/ci-local.ts --gates --jobs 2   # overlap the heavy gates (see BEHAVIOR)",
	"#",
	"#   --tsv exists so OTHER tools can consume the ONE parser rather than growing a",
	"#   second copy of the matrix — bun-apps/tests/ci-workflow-references.test.ts (the",
	"#   guard that every matrix row points at a real package, and every package has a",
	"#   row) reads it. Keep it decoration-free: no colors, no headers, no totals, and",
	"#   keep the plain form at exactly two fields: that IS the contract that guard",
	"#   depends on. `--gates --tsv` is the separate three-field form.",
	"#",
	"# TIMEOUTS (2026-08-24 — the operator's controllability ask: no gate may hang",
	"# the lane, and the whole gates run must fit a wall-clock budget)",
	"#   --gate-timeout-ms <ms>  per-gate hard kill cap (default 240000). A gate",
	"#                           that exceeds it FAILS as HUNG — a hang is a",
	"#                           failure signal, never something to wait out.",
	"#   --budget-ms <ms>        whole-run wall-clock budget (default 0 = off).",
	"#                           When the clock crosses it, every remaining gate",
	"#                           is SKIPPED (loudly, never silently) and the run",
	"#                           EXITS 1 listing them — budget exhaustion is a",
	"#                           FAIL, not a green.",
	"#   --jobs <n>              gates-only parallelism (default 1). n workers",
	"#                           pull gates; gates whose label matches the",
	"#                           EXCLUSIVE set (deploy-tree mutations: the",
	"#                           Deploy-sh L1 e2e builds and repoints deploy",
	"#                           state) serialize among themselves while the",
	"#                           read-only gates fill the lanes. The matrix run",
	"#                           stays sequential regardless — matrix entries",
	"#                           race s2-agent-ext-ultracode's shared dist/.",
	"# BEHAVIOR",
	"#   - Matrix: sequential (parallel runs race s2-agent-ext-ultracode's shared dist/)."
].join("\n") + "\n";

// ── colors (disabled when stdout isn't a TTY, for clean logs) ────────────────
const TTY = process.stdout.isTTY === true;
const G = (s: string): string => (TTY ? `\x1b[32m${s}\x1b[0m` : s);
const Y = (s: string): string => (TTY ? `\x1b[33m${s}\x1b[0m` : s);
const R = (s: string): string => (TTY ? `\x1b[31m${s}\x1b[0m` : s);
const B = (s: string): string => (TTY ? `\x1b[34m${s}\x1b[0m` : s);
const D = (s: string): string => (TTY ? `\x1b[2m${s}\x1b[0m` : s);

const step = (a: string, b: string): void => {
	process.stdout.write(`\n${B("▶")} ${a} ${D(b)}\n`);
};
const okOk = (a: string): void => {
	process.stdout.write(`${G("✓")} ${a}\n`);
};
const warn = (a: string): void => {
	process.stdout.write(`${Y("·")} ${a}\n`);
};
const fail = (a: string): void => {
	process.stdout.write(`${R("✗")} ${a}\n`);
};
// A function declaration (not a const arrow): tsc's control-flow analysis only
// treats a call as flow-exiting when the called entity is declared as a
// function whose return type is `never`.
function die(a: string): never {
	process.stderr.write(`${R("ci-local FAILED:")} ${a}\n`);
	process.exit(2);
}

// ── flag parsing (the .sh's while/case, order-sensitive) ─────────────────────
let listOnly = false;
let tsvOnly = false;
let gates = false;
let only = "";
let jobs = 1;
let gateTimeoutMs = 240_000;
let budgetMs = 0;
{
	const intFlag = (name: string, value: string | undefined, min: number): number => {
		const n = Number(value);
		if (value === undefined || !Number.isInteger(n) || n < min) {
			process.stdout.write(`${name} needs an integer ≥ ${min}\n`);
			process.exit(2);
		}
		return n;
	};
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--list") {
			listOnly = true;
		} else if (a === "--tsv") {
			tsvOnly = true;
		} else if (a === "--gates") {
			gates = true;
		} else if (a === "--jobs") {
			jobs = intFlag("--jobs", argv[++i], 1);
		} else if (a.startsWith("--jobs=")) {
			jobs = intFlag("--jobs", a.slice("--jobs=".length), 1);
		} else if (a === "--gate-timeout-ms") {
			gateTimeoutMs = intFlag("--gate-timeout-ms", argv[++i], 1000);
		} else if (a.startsWith("--gate-timeout-ms=")) {
			gateTimeoutMs = intFlag("--gate-timeout-ms", a.slice("--gate-timeout-ms=".length), 1000);
		} else if (a === "--budget-ms") {
			budgetMs = intFlag("--budget-ms", argv[++i], 1000);
		} else if (a.startsWith("--budget-ms=")) {
			budgetMs = intFlag("--budget-ms", a.slice("--budget-ms=".length), 1000);
		} else if (a === "--only") {
			only = argv[i + 1] ?? "";
			// .sh: ONLY="${2-}"; [ -n "$ONLY" ] || { echo "…"; exit 2 } — a
			// trailing `--only` with no value is a usage error, not "no filter".
			if (only === "") {
				process.stdout.write("--only needs a value\n");
				process.exit(2);
			}
			i++;
		} else if (a.startsWith("--only=")) {
			// .sh quirk, pinned by the parity test: `--only=` binds an EMPTY
			// value and skips the needs-a-value check — the result is NO
			// filter (the whole matrix), never a usage error.
			only = a.slice("--only=".length);
		} else if (a === "-h" || a === "--help") {
			process.stdout.write(HELP);
			process.exit(0);
		} else {
			// .sh's `*)`: an unknown flag AND a bare positional both die here —
			// there is no positional form ("bogus" is not a package name, it is
			// an unknown flag; use --only bogus to make that the real error).
			process.stdout.write(`unknown flag: ${a} (see --help)\n`);
			process.exit(2);
		}
	}
}
// --jobs is a gates-lane lever only: the matrix run must stay sequential
// (parallel matrix entries race s2-agent-ext-ultracode's shared dist/).
if (jobs > 1 && !gates) {
	process.stdout.write("--jobs > 1 applies to --gates only; the matrix run is sequential by contract\n");
	process.exit(2);
}
if (gates && only !== "") {
	process.stdout.write("--only filters matrix packages; it does not apply to --gates\n");
	process.exit(2);
}

// ── workflow parse ───────────────────────────────────────────────────────────
// Both parsers are Bun's native YAML — the authoritative path of the .sh's
// python parse (the .sh also had a line-parser fallback for a python3 without
// PyYAML, and a --gates exit-4 for the same hole; Bun carries its own YAML, so
// neither exists here — measured divergence, strictly better, see the parity
// test's provenance). Degradation contract is INVERTED vs src/ci-matrix.ts
// (readCiMatrix returns {} so run_local_ci stays usable): the .sh fails the
// run on any shape that isn't the expected matrix — an empty parse must never
// read as "everything passed". Order is preserved (readCiMatrix is a map).
type MatrixRow = [packageName: string, testCmd: string];

/** The run is REFUSED (never an empty pass) — keep the parse shape stable. */
const MATRIX_PARSE_ERR = (w: string): string =>
	`could not parse the tests matrix out of ${w} — keep the YAML as ` +
	`{jobs.tests.strategy.matrix.include:[{package,test-cmd}]}`;

const GATES_PARSE_ERR = (w: string): string =>
	`could not parse the regression-gates job out of ${w} — keep the YAML as ` +
	`{jobs.regression-gates.steps:[{name,run,working-directory}]}`;

function workflowDoc(): unknown {
	try {
		return Bun.YAML.parse(readFileSync(WORKFLOW_PATH, "utf8"));
	} catch {
		die(MATRIX_PARSE_ERR(WORKFLOW));
	}
}

/** Fail loudly on a value that isn't a YAML list — never degrade to "no rows". */
function requireArray(v: unknown, message: string): unknown[] {
	if (!Array.isArray(v)) die(message);
	return v;
}

function parseMatrix(): MatrixRow[] {
	const doc = workflowDoc() as {
		jobs?: { tests?: { strategy?: { matrix?: { include?: unknown } } } };
	};
	const rows: MatrixRow[] = [];
	for (const entry of requireArray(
		doc?.jobs?.tests?.strategy?.matrix?.include,
		MATRIX_PARSE_ERR(WORKFLOW),
	)) {
		const e = entry as { package?: unknown; "test-cmd"?: unknown };
		const pkg = e?.package;
		const testCmd = e?.["test-cmd"];
		if (typeof pkg !== "string" || typeof testCmd !== "string") {
			// .sh: "unexpected matrix entry" → the run is refused, not subset.
			die(MATRIX_PARSE_ERR(WORKFLOW));
		}
		rows.push([pkg, testCmd]);
	}
	if (rows.length === 0) {
		die(`parsed an EMPTY matrix from ${WORKFLOW}`);
	}
	return rows;
}

// ── --only filter ────────────────────────────────────────────────────────────
let matrix = parseMatrix();
{
	if (only !== "") {
		const filtered: MatrixRow[] = [];
		for (const w of only.split(",")) {
			const name = w.replace(/\s/g, ""); // .sh: tr -d '[:space:]'
			if (name === "") continue;
			const hit = matrix.filter((r) => r[0] === name);
			if (hit.length === 0) {
				die(`--only: '${name}' is not a package in the ${WORKFLOW} tests matrix (run --list)`);
			}
			filtered.push(...hit);
		}
		matrix = filtered;
	}
}

// ── the regression-gates job (--gates) ───────────────────────────────────────
// Same semantics as the .sh's parse_gates: skip `uses:` steps (they set up a
// runner; a dev machine already is one), REFUSE on a step with an `if:`
// (a GitHub expression's truth value cannot be evaluated here — refuse rather
// than silently run the wrong gate set), join a multi-line `run:` with spaces,
// and fail loudly on ZERO steps or a restructured job. All failures exit 2
// via die() — the .sh had an extra exit 4 for "PyYAML missing" that a Bun.YAML
// port cannot reach; .githooks/pre-push's 4→warn degradation simply never
// fires, which is the point (it existed for a machine that cannot parse YAML).
interface GateRow {
	label: string;
	dir: string;
	cmd: string;
}

function parseGates(): GateRow[] {
	const doc = workflowDoc() as { jobs?: Record<string, unknown> } | null;
	const job = doc?.jobs?.["regression-gates"];
	const steps = (job as { steps?: unknown } | undefined)?.steps;
	const rows: GateRow[] = [];
	for (const raw of requireArray(steps, GATES_PARSE_ERR(WORKFLOW))) {
		const s = raw as { run?: unknown; name?: unknown; "working-directory"?: unknown; if?: unknown };
		if (typeof s?.run !== "string") continue; // `uses:` steps
		if (s.if !== undefined) {
			die(GATES_PARSE_ERR(WORKFLOW));
		}
		rows.push({
			label: typeof s.name === "string" ? s.name : "<unnamed>",
			dir: typeof s["working-directory"] === "string" ? s["working-directory"] : ".",
			// .sh: " ".join(run.strip().split("\n")) — newlines collapse, no
			// per-line trim.
			cmd: s.run.trim().split("\n").join(" "),
		});
	}
	if (rows.length === 0) {
		die(GATES_PARSE_ERR(WORKFLOW));
	}
	return rows;
}

// ── normalize to <label, dir, cmd> (both modes run the same loop) ────────────
let rows: GateRow[];
let unit = "package";
let sourceDesc = "tests matrix";
if (gates) {
	rows = parseGates();
	unit = "gate";
	sourceDesc = "regression-gates job";
} else {
	rows = matrix.map(([pkg, testCmd]) => ({ label: pkg, dir: `bun-apps/${pkg}`, cmd: testCmd }));
}
const total = rows.length;

// ── --tsv (before --list, like the .sh: `--tsv --list` still yields TSV) ─────
// The machine-readable face of the SAME parse --list renders for humans.
// WITHOUT --gates it is exactly "<package>\t<test-cmd>" — two fields, no
// colors/headers/totals — consumed by bun-apps/tests/ci-workflow-references
// .test.ts. Do not widen it. `--gates --tsv` is the three-field form.
if (tsvOnly) {
	if (gates) {
		for (const r of rows) process.stdout.write(`${r.label}\t${r.dir}\t${r.cmd}\n`);
	} else {
		for (const [pkg, testCmd] of matrix) process.stdout.write(`${pkg}\t${testCmd}\n`);
	}
	process.exit(0);
}

// ── --list ───────────────────────────────────────────────────────────────────
// The eyeball check that the parse is correct: every row, its directory status,
// and the exact command that will run. Compare against the workflow by hand
// once after any parser change.
if (listOnly) {
	process.stdout.write(`${B("ci-local --list")} ${D(`(parsed from ${WORKFLOW} · ${sourceDesc})`)}\n`);
	process.stdout.write(
		`${D(`${total} entr${total === 1 ? "y" : "ies"}; each runs in its directory with CI=true`)}\n`,
	);
	process.stdout.write("\n");
	const unitUpper = unit.toUpperCase();
	const hdr = (a: string, b: string, c: string, d: string): string =>
		`${a.padEnd(3)} ${b.padEnd(4)} ${c.padEnd(32)} ${d}\n`;
	process.stdout.write(hdr("#", "DIR", unitUpper, "COMMAND"));
	process.stdout.write(hdr("---", "----", "-".repeat(32), "--------"));
	let n = 0;
	for (const r of rows) {
		n++;
		const mark = existsSync(resolve(REPO_ROOT, r.dir)) ? `${G("ok")}  ` : `${R("MISS")}`;
		process.stdout.write(`${String(n).padEnd(3)} ${mark} ${r.label.slice(0, 32).padEnd(32)} ${r.cmd}\n`);
	}
	process.stdout.write("\n");
	if (gates) {
		process.stdout.write(`${D("This is the regression-gates job. Run the tests matrix with no --gates flag.")}\n`);
	} else {
		process.stdout.write(`${D("Not covered by this script: extension-contract, deploy-verify, compile-verify,")}\n`);
		process.stdout.write(`${D("clean-launch-self-heal, determinism-spotcheck. Run regression-gates with --gates.")}\n`);
	}
	process.exit(0);
}

// ── self-heal bun-apps workspace links before running anything ───────────────
// WHY (2026-08-15): running s2-agent's test suite (specifically importing
//   src/patches/ensure-extension-deps.ts under `bun test` from the bun-apps
//   workspace root) makes the BUN RUNTIME rewrite bun-apps/node_modules/@repo/*
//   symlinks to `../../bun-apps/<pkg>` — a DANGLING target at that depth (it
//   resolves to bun-apps/bun-apps/<pkg>). The next gate that resolves a @repo/*
//   import from bun-apps/tests/ (the seam guard importing core-interface) then
//   dies with ENOENT. Matrix mode breaks the links; gates mode then pays for
//   it. Repairing here — relink any dangling @repo/* entry to `../../<dir>`,
//   bun's own correct form — makes every ci-local invocation self-healing
//   regardless of what a previous run did to the tree. (Verbatim port of the
//   .sh's heal_repo_links.)
function healRepoLinks(): void {
	const dirs = resolve(REPO_ROOT, "bun-apps/node_modules/@repo");
	if (!existsSync(dirs)) return;
	let linksFixed = 0;
	for (const name of readdirSync(dirs)) {
		const p = resolve(dirs, name);
		if (!lstatSync(p).isSymbolicLink()) continue;
		if (existsSync(p)) continue; // resolves — leave it alone
		rmSync(p);
		symlinkSync(`../../${name}`, p);
		linksFixed++;
	}
	if (linksFixed > 0) {
		warn(`relinked ${linksFixed} dangling @repo/* workspace link(s) (bun-test runtime interference)`);
	}
}
healRepoLinks();

// ── run ──────────────────────────────────────────────────────────────────────
const LOG_DIR = mkdtempSync(`${tmpdir()}/ci-local.`);
const PASSED: string[] = [];
const FAILED: string[] = [];
const SKIPPED: string[] = [];
const TIMINGS: string[] = [];
const RUN_START_MS = Date.now();

const slug = (label: string): string => label.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);

process.stdout.write(
	`${B("ci-local")} — CI ${sourceDesc}, run locally ${D(
		`(${total} entries, ${gates && jobs > 1 ? `${jobs} lanes` : "sequential"}, CI=true)`,
	)}\n`,
);
process.stdout.write(`${D(`source: ${WORKFLOW} · logs: ${LOG_DIR}`)}\n`);
if (gates) {
	process.stdout.write(`${Y("NOTE")} regression-gates only — the tests matrix is NOT run (drop --gates for that).\n`);
	if (gateTimeoutMs > 0) {
		process.stdout.write(
			`${D(`gate timeout: ${Math.round(gateTimeoutMs / 1000)}s${budgetMs > 0 ? ` · budget: ${Math.round(budgetMs / 1000)}s` : ""}`)}\n`,
		);
	}
} else {
	process.stdout.write(`${Y("NOTE")} matrix tests only — extension-contract / deploy-verify / compile-verify /\n`);
	process.stdout.write("     determinism-spotcheck are NOT run, and regression-gates needs --gates.\n");
}
process.stdout.write("     Green here != green CI.\n");

// Gates whose execution MUTATES shared machine state (the deploy outRoot: a
// live build + current repoint). With --jobs > 1 they serialize among
// themselves while read-only gates fill the other lanes; they may still
// overlap read-only gates (tsc/biome/audits never touch the deploy tree).
const EXCLUSIVE_GATE_RE = /deploy-sh l1/i;
const BUDGET_SKIPPED: string[] = [];

async function runGate(r: (typeof rows)[number], idx: number): Promise<void> {
	if (!existsSync(resolve(REPO_ROOT, r.dir))) {
		// Dead row: the workflow names a directory that isn't in the tree. Loud
		// SKIP, never a silent pass — that is how s2-agent-ext-picker stayed in
		// the matrix unnoticed. Dead rows do NOT fail the run; they are counted
		// and re-listed in the summary so they get cleaned up.
		step(`[${idx}/${total}] ${r.label}`, "SKIPPED");
		warn(`${Y("DEAD ROW")}: ${r.dir}/ does not exist — the workflow names a`);
		process.stdout.write(`  directory that isn't in the tree. Not a pass: fix the row in ${WORKFLOW}\n`);
		process.stdout.write("  (and, for a matrix package, the required-checks list in .github/CI.md).\n");
		SKIPPED.push(r.label);
		return;
	}

	// Budget gate: checked BEFORE spawning — a gate that would start past the
	// wall-clock budget is skipped loudly and fails the run at the summary.
	if (budgetMs > 0 && Date.now() - RUN_START_MS > budgetMs) {
		step(`[${idx}/${total}] ${r.label}`, "SKIPPED");
		warn(`${Y("BUDGET")}: wall clock crossed ${Math.round(budgetMs / 1000)}s before this gate started —`);
		process.stdout.write("  skipped, NOT passed. Raise --budget-ms or fix the slow gate (per-gate times in the summary).\n");
		BUDGET_SKIPPED.push(r.label);
		return;
	}

	step(`[${idx}/${total}] ${r.label}`, r.cmd);
	const t0 = Date.now();
	// .sh: ( cd "$dir" && CI=true bash -c "$cmd" ) >"$log" 2>&1 — the row's
	// command is shell syntax (`bun test && bun run qa`), so bash -c stays the
	// executor; CI=true is exactly what GitHub Actions sets (machine-coupled
	// tests skip on it), and it must not leak into this script's own env.
	// ASYNC spawn (2026-08-24): node's spawnSync BLOCKS the event loop, which
	// silently serialized the --jobs lanes (measured: two "overlapped" heavy
	// gates ran back-to-back, 146s wall). Bun.spawn + awaited streams is the
	// only way the lanes actually overlap. The timer is the gate timeout: a
	// gate may never hang the lane — killed at the cap, null status = HUNG.
	// A --budget-ms also BINDS a gate that already started (min of the two
	// caps): otherwise a 99s gate started at 4.9s would run past a 5s budget
	// and the wall-clock control would be advisory, not hard.
	const remainingBudget = budgetMs > 0 ? budgetMs - (Date.now() - RUN_START_MS) : Number.POSITIVE_INFINITY;
	const capMs = Math.max(1000, Math.min(gateTimeoutMs, remainingBudget));
	const budgetBinds = capMs < gateTimeoutMs;
	const proc = Bun.spawn(["bash", "-c", r.cmd], {
		cwd: resolve(REPO_ROOT, r.dir),
		env: { ...process.env, CI: "true" },
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			proc.kill(9);
		} catch {
			/* already exited */
		}
	}, capMs);
	let stdout = "";
	let stderr = "";
	try {
		[stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	} finally {
		clearTimeout(timer);
	}
	const status = await proc.exited;
	const child = { stdout, stderr, status: timedOut ? null : status };
	const dt = Math.floor((Date.now() - t0) / 1000);
	const logPath = `${LOG_DIR}/${slug(r.label)}.log`;
	writeFileSync(logPath, `${child.stdout ?? ""}${child.stderr ?? ""}`);
	const hung = timedOut || child.status === null || child.status > 128;
	const rc = hung ? 1 : (child.status ?? 1);
	TIMINGS.push(`${r.label}\t${dt}\t${hung ? "hung" : rc}`);

	if (!hung && rc === 0) {
		// .sh: grep -aE '^[[:space:]]*[0-9]+ (pass|tests)' | tail -1 | xargs
		const summary =
			(child.stdout ?? "")
				.split("\n")
				.filter((l) => /^\s*\d+ (pass|tests)/.test(l))
				.at(-1)?.trim();
		okOk(`${r.label} ${D(`(${dt}s)`)}${summary ? ` — ${summary}` : ""}`);
		PASSED.push(r.label);
	} else {
		const hungWhy = timedOut
			? budgetBinds
				? `KILLED at the ${Math.round(budgetMs / 1000)}s wall-clock budget`
				: `HUNG — killed at the ${Math.round(gateTimeoutMs / 1000)}s gate timeout`
			: `exit ${rc}`;
		fail(`${r.label} ${D(`(${dt}s, ${hungWhy})`)}`);
		process.stdout.write(`${D(`--- last 25 lines of ${logPath} ---`)}\n`);
		const log = readFileSync(logPath, "utf8");
		const body = log === "" ? "" : log.endsWith("\n") ? log.slice(0, -1) : log;
		for (const line of body.split("\n").slice(-25)) {
			process.stdout.write(`  ${line}\n`);
		}
		process.stdout.write(`${D("--- end ---")}\n`);
		FAILED.push(r.label);
	}
}

if (gates && jobs > 1) {
	// Heavy-first ordering: the two long gates (the deploy L1 e2e ~99s, the
	// ext-entry typecheck ~45s) sit at matrix positions 19 and 21 — pulled in
	// index order they only START after ~10s of light gates, which on a slow
	// LLM round trip pushes the wall clock against the budget (measured
	// 1:59.8 against a 120s cap). Starting them first hides that lead-in
	// under their own runtime; light gates fill the second lane. Relative
	// order within each group is preserved, so the [idx/total] markers stay
	// stable identifiers (they were never a sequence — lanes complete
	// out of order by construction).
	const HEAVY_GATE_RE = /deploy-sh l1|typecheck \(executor/i;
	const ordered = [...rows.filter((r) => HEAVY_GATE_RE.test(r.label)), ...rows.filter((r) => !HEAVY_GATE_RE.test(r.label))];
	// n workers pull gates by index; an EXCLUSIVE gate chains onto the previous
	// exclusive one (never two deploy-tree mutations at once) while the worker
	// that claimed it waits — read-only gates on other lanes keep flowing.
	let next = 0;
	let exclusiveChain: Promise<void> = Promise.resolve();
	const worker = async (): Promise<void> => {
		for (;;) {
			const i = next++;
			if (i >= ordered.length) return;
			const r = ordered[i]!;
			if (EXCLUSIVE_GATE_RE.test(r.label)) {
				const run = exclusiveChain.then(() => runGate(r, rows.indexOf(r) + 1));
				exclusiveChain = run.catch(() => {});
				await run;
			} else {
				await runGate(r, rows.indexOf(r) + 1);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, ordered.length)) }, worker));
} else {
	let idx = 0;
	for (const r of rows) {
		await runGate(r, ++idx);
	}
}

const TOTAL_TIME = Math.floor((Date.now() - RUN_START_MS) / 1000);

// ── summary ──────────────────────────────────────────────────────────────────
const W = 48;
const unitUpper = unit.toUpperCase();
process.stdout.write(`\n${B("══ summary ══")} ${D(`(${TOTAL_TIME}s total)`)}\n`);
process.stdout.write(`${unitUpper.padEnd(W)} ${"TIME".padStart(8)}  ${"RESULT"}\n`);
for (const row of TIMINGS) {
	const [label, t, r] = row.split("\t");
	const res = r === "hung" ? R("FAIL (HUNG)") : Number(r) === 0 ? G("PASS") : `${R(`FAIL (exit ${r})`)}`;
	process.stdout.write(`${label!.slice(0, W).padEnd(W)} ${t!.padStart(7)}s  ${res}\n`);
}
for (const p of SKIPPED) {
	process.stdout.write(`${p.slice(0, W).padEnd(W)} ${"-".padStart(8)}  ${Y("SKIP")} (directory missing — dead row)\n`);
}
for (const p of BUDGET_SKIPPED) {
	process.stdout.write(`${p.slice(0, W).padEnd(W)} ${"-".padStart(8)}  ${Y("SKIP")} (budget exhausted — NOT a pass)\n`);
}

process.stdout.write(
	`\npassed: ${PASSED.length}   failed: ${FAILED.length}   skipped: ${SKIPPED.length + BUDGET_SKIPPED.length}   of ${total}\n`,
);

if (BUDGET_SKIPPED.length > 0) {
	process.stdout.write(`\n${R(`BUDGET EXHAUSTED (${BUDGET_SKIPPED.length} gate(s) never ran):`)}\n`);
	for (const p of BUDGET_SKIPPED) process.stdout.write(`  - ${p}\n`);
	process.stdout.write("  Budget exhaustion is a FAIL, not a green — unrun gates prove nothing.\n");
	process.stdout.write("  Raise --budget-ms, or fix the slow gate (see per-gate times above).\n");
}

if (SKIPPED.length > 0) {
	process.stdout.write(`\n${Y("Dead rows (named in CI but absent from the tree):")}\n`);
	for (const p of SKIPPED) process.stdout.write(`  - ${p}\n`);
}

if (FAILED.length > 0 || BUDGET_SKIPPED.length > 0) {
	if (FAILED.length > 0) {
		process.stdout.write(`\n${R(`FAILURES (${FAILED.length}):`)}\n`);
		for (const p of FAILED) {
			process.stdout.write(`  - ${p}   ${D(`(log: ${LOG_DIR}/${slug(p)}.log)`)}\n`);
		}
	}
	process.stdout.write(`\n${R("ci-local: FAIL")}\n`);
	process.exit(1);
}

process.stdout.write("\n");
if (gates) {
	process.stdout.write(`${G("ci-local: PASS")} ${D("— regression-gates only; the tests matrix was NOT run.")}\n`);
} else {
	process.stdout.write(`${G("ci-local: PASS")} ${D("— matrix only; the non-matrix jobs listed above were NOT run.")}\n`);
}
process.exit(0);
