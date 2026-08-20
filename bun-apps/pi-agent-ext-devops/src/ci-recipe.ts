/**
 * runLocalCi — the PURE orchestration behind the `local_ci` tool. It mirrors
 * what remote CI would do, but LOCALLY and OFFLINE (no network): typecheck +
 * lint + tests scoped to the packages affected vs origin/main, plus the repo's quality
 * gates (file-size guard, lockfile-duplicate guard, optional audit gates, and an
 * info-only schema-cost check). Returns a STRUCTURED pass/fail so the agent can
 * decide "safe to merge" without eyeballing terminal noise.
 *
 * The recipe itself never touches the shell — every process spawn goes through
 * the injectable `SpawnFn` seam (src/spawn.ts), so the whole flow is fully
 * testable with a recording fake and has zero coupling to the real filesystem /
 * git state. The live `SpawnFn` (`createLiveSpawn`) is the only untested seam.
 *
 * Change detection runs IN-PROCESS (src/changed-packages.ts — the extension-native
 * TS port of the former scripts/ci-changed-packages.sh); the GATE suite uses the
 * SAME committed scripts remote CI uses (scripts/ci-file-size-guard.sh, …), so a
 * green run here is the local proxy for a green remote run — the rationale for
 * the repo-wide "never wait for remote CI; self-verify then `gh ship`" rule.
 *
 * That proxy only holds if the per-package COMMAND matches too, so the test step
 * is sourced from the CI matrix (src/ci-matrix.ts) rather than derived generically
 * — otherwise `bun run test` would stand in for `bun test --isolate`, `bun test &&
 * bun run qa`, or a build-first row, and local_ci could report green on a package
 * whose real CI command fails. Packages with no matrix row keep the generic
 * derivation. scripts/ci-local.sh parses the same matrix block, so the two local
 * runners cannot disagree about what a package's command is.
 *
 * One gate is hand-added beside the workflow-derived set beyond
 * oneshot-smoke: the change-triggered deploy-e2e gate (src/ci-deploy-gate.ts)
 * — PI_AGENT_E2E bundle-mode assertions, only when the diff is
 * deploy-sensitive (see ci-deploy-gate.ts for the rationale).
 */
import { SPAWN_TIMEOUT_EXIT_CODE, type SpawnFn } from "./spawn.js";
import { runSchemaCostCheck } from "./schema-cost-check.js";
import {
	computeChangedPackages,
	type ChangedPackagesMap,
	type ComputeChangedPackagesOptions,
} from "./changed-packages.js";
import { readCiMatrix, type CiMatrix } from "./ci-matrix.js";
import { readCiGates, LOCAL_ONLY_AUDITS, type CiGatesResult } from "./ci-gates.js";
import { ONESHOT_SMOKE_GATE_NAME, runOneshotSmoke, type OneshotSmokeResult } from "./oneshot-smoke.js";
import {
	DEPLOY_E2E_COMMAND,
	DEPLOY_E2E_GATE_NAME,
	shouldRunDeployE2e,
} from "./ci-deploy-gate.js";

export interface CiPackageResult {
	name: string;
	typecheck?: {
		exitCode: number;
		skipped?: boolean;
		note?: string;
		durationMs?: number;
		/** Captured output tail on a FAILED typecheck (see `failureDetail`). */
		detail?: string;
	};
	/**
	 * Biome result. Symmetric to `typecheck`, and separate for the same reason
	 * the two tools are separate: a type error is a defect, a lint/format error
	 * is drift. Only packages that declare a biome-invoking script are run —
	 * `skipped: "no biome key"` otherwise. Whether a package that HAS a
	 * biome.json declares such a script is a different claim, owned by
	 * `tests/lint-executor-coverage.test.ts` (the same split as the typecheck
	 * executor and its coverage guard).
	 */
	lint?: {
		exitCode: number;
		skipped?: boolean;
		note?: string;
		durationMs?: number;
		/** Captured output tail on a FAILED lint (see `failureDetail`). */
		detail?: string;
	};
	test: {
		exitCode: number;
		note?: string;
		/**
		 * Where the test command came from. `"matrix"` = the package's row in
		 * .github/workflows/ci.yml.disabled (what remote CI would actually run);
		 * `"package-script"` = the generic `bun run test` fallback for a package
		 * with no matrix row. Absent when nothing ran.
		 */
		source?: "matrix" | "package-script";
		/** The command as executed, for matrix rows (the row's `test-cmd`). */
		command?: string;
		durationMs?: number;
		/** Captured output tail on a FAILED test run (see `failureDetail`). */
		detail?: string;
	};
}

export interface CiGateResult {
	/** The workflow step's `name:` (or, for a `strict` extra, the script filename). */
	name: string;
	exitCode: number;
	/** One-liner outcome note (set by the in-process oneshot-smoke gate). */
	note?: string;
	/** Multi-line diagnostics on a failed gate (timeout recipe / captured tail). */
	detail?: string;
}

export interface CiOutcome {
	overall: "pass" | "fail";
	baseRef: string;
	headRef: string;
	packages: CiPackageResult[];
	gates: CiGateResult[];
	/** Info-only: a non-zero schema-cost exit NEVER affects `overall`. */
	schemaCost?: { exitCode: number; note: string };
	elapsedMs: number;
	/**
	 * The ≤5-minute budget this run was held to (default 300 000 ms — a house
	 * rule: a local_ci run over ~5 minutes is bad CI and gets optimized, not
	 * accepted). Advisory: `overBudget` NEVER flips `overall`.
	 */
	budgetMs: number;
	/** elapsedMs > budgetMs. Advisory signal for callers to print loudly. */
	overBudget: boolean;
	/** Top (≤5) packages by typecheck+test wall-clock, slowest first. */
	slowest: Array<{ name: string; durationMs: number }>;
	/**
	 * Set when change detection FAILED — `computeChangedPackages` threw (a genuine
	 * I/O failure; its fail-open cases return all-true instead of throwing). Then
	 * `overall` is "fail", `packages`/`gates` are empty, and the per-package loop
	 * + gates are skipped: a detection error must NEVER be coerced to an empty
	 * package set (that yields a false-green).
	 */
	detectionError?: string;
	/**
	 * Set when the `regression-gates` job could not be read out of the workflow.
	 * `overall` is then "fail" and NO gate ran. An empty gate list is
	 * indistinguishable from "every gate passed", so this fails closed rather
	 * than letting `await_pr_merge` squash-merge on a gate suite that never ran.
	 */
	gateError?: string;
}

export interface CiOptions {
	repoRoot: string;
	/** Base ref to diff against. Default "origin/main". Must already exist locally. */
	baseRef?: string;
	/** Head ref. Default "HEAD". */
	headRef?: string;
	/** Explicit package list → skip change detection entirely. */
	packages?: string[];
	/** Run every bun-apps/* package (computeChangedPackages all:true). */
	all?: boolean;
	/**
	 * Also run the audits that have NO workflow step (`LOCAL_ONLY_AUDITS`).
	 * Default (false) runs exactly the `regression-gates` job — no more, no less.
	 */
	strict?: boolean;
	/** Run the gate suite. Default true. */
	includeGates?: boolean;
	/** Injectable process spawn (live: src/spawn.ts createLiveSpawn; tests: fake). */
	spawn: SpawnFn;
	/** Abort signal; the recipe stops spawning further commands when fired. */
	signal?: AbortSignal;
	/** Injectable package.json reader. Default: read <pkgDir>/package.json. */
	readPkg?: (pkgDir: string) => Promise<{ scripts?: Record<string, string> }>;
	/**
	 * Injectable changed-package detector. Default: `computeChangedPackages`
	 * (the extension-native TS port of the former ci-changed-packages.sh).
	 * Tests inject a fake so the recipe stays filesystem/git-free.
	 */
	detectChangedPackages?: (opts: ComputeChangedPackagesOptions) => Promise<ChangedPackagesMap>;
	/**
	 * Injectable CI-matrix reader (`package` → `test-cmd`). Default: parse
	 * .github/workflows/ci.yml.disabled. A package WITH a row runs that exact
	 * command; a package without one falls back to the generic `bun run test`
	 * derivation. Tests inject a fixed map so the recipe stays filesystem-free.
	 */
	readMatrix?: (repoRoot: string) => Promise<CiMatrix>;
	/**
	 * Injectable `regression-gates` reader. Default: parse the job out of
	 * .github/workflows/ci.yml.disabled. Tests inject a fixed list so the recipe
	 * stays filesystem-free.
	 */
	readGates?: (repoRoot: string) => Promise<CiGatesResult>;
	/**
	 * Injectable oneshot-smoke boot gate (default: src/oneshot-smoke.ts, which
	 * returns null for a repoRoot that is not this monorepo). Tests inject a
	 * fake so the recipe stays filesystem/spawn-free.
	 */
	runOneshotSmoke?: (o: {
		repoRoot: string;
		spawn: SpawnFn;
		now: () => number;
	}) => Promise<OneshotSmokeResult | null>;
	/**
	 * Where the schema-cost check's human-readable block goes. Default stdout via
	 * console.log. `runSchemaCostCheck` is IMPORTED, not spawned, so in a caller
	 * whose own stdout is a payload (the devops CLIs) that banner corrupts it —
	 * those pass a stderr sink here.
	 */
	log?: (line: string) => void;
	/** Baseline JSON path forwarded to the schema-cost check (tests pin a fixture). */
	schemaCostBaseline?: string;
	/**
	 * Wall-clock budget in ms. Default 300 000 (the ≤5-minute house rule).
	 * Overruns are reported (`overBudget`) but never fail `overall`.
	 */
	budgetMs?: number;
	/**
	 * Hard per-command wall-clock cap in ms, applied to every typecheck and test
	 * spawn. Default 120 000 — ~4.6x the slowest real package (pi-agent, ~26s),
	 * so it can only ever catch a HANG, never a slow suite.
	 *
	 * Sized against `budgetMs`, not against the slowest package alone: a single
	 * command allowed 10 minutes can blow the ≤5-minute run budget by itself.
	 * Measured 2026-08-15 — `pi-agent-ext-archify` hangs under the parallel phase
	 * (it passes in 4s alone) and ate the full 600s cap, turning a 40s run into a
	 * 639s one. At 120s the same hang costs 2 minutes and still reports.
	 *
	 * Distinct from `budgetMs`, which is advisory and measured after the fact.
	 * This one actually kills, because "report the overrun once it finishes" is
	 * no help when the thing never finishes.
	 */
	perCommandTimeoutMs?: number;
	/** Injectable clock for deterministic budget tests. Default Date.now. */
	now?: () => number;
	/**
	 * Max PARALLEL processes for the read-only typecheck phase and the
	 * non-build test phase. Build-bearing test rows always run sequentially
	 * first (they write shared dist/ trees; parallel runs race them). Default 4.
	 */
	concurrency?: number;
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving item
 * order in the results. Workers that throw resolve to null (a failed step is
 * data, not an abort).
 */
async function mapPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<Array<R | null>> {
	const results: Array<R | null> = new Array(items.length).fill(null);
	let next = 0;
	const run = async () => {
		while (next < items.length) {
			const i = next++;
			try {
				results[i] = await worker(items[i]!);
			} catch {
				results[i] = null;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
	return results;
}

/**
 * Relink any DANGLING `bun-apps/node_modules/@repo/*` symlink to bun's own
 * correct `../../<dir>` form. Needed because the Bun runtime (observed
 * 2026-08-15, Bun 1.3.14) rewrites those links to `../../bun-apps/<dir>` —
 * dangling at that depth — when a `bun test` process imports
 * pi-agent's ensure-extension-deps patch; left broken, the next package that
 * resolves a `@repo/*` import from the workspace root dies with ENOENT
 * (btw/movie-director typecheck exit 2, archify test exit 1 — all transient
 * victims of pi-agent's suite running concurrently). Best-effort: the spawn's
 * exit code is advisory, never a gate.
 */
async function healWorkspaceLinks(spawn: SpawnFn, repoRoot: string): Promise<void> {
	const script =
		'for d in "$1"/bun-apps/node_modules/@repo/*; do [ -L "$d" ] && [ ! -e "$d" ] || continue; ' +
		'n="$(basename "$d")"; rm -f "$d"; ln -s "../../$n" "$d"; done';
	try {
		await spawn("bash", ["-c", script, "heal-workspace-links", repoRoot], { cwd: repoRoot });
	} catch {
		/* advisory only */
	}
}

/** A gate's invocation: how to spawn it + whether its failure fails `overall`. */
interface GateSpec {
	/** Bare filename under scripts/ (e.g. "ci-file-size-guard.sh"). */
	file: string;
	/** Runner chosen by extension so the gate actually executes (see dispatchGate). */
	cmd: string;
	args: string[];
	blocking: boolean;
}

/** Always-on (v1) blocking gates. */
const BLOCKING_GATES_V1 = ["ci-file-size-guard.sh", "check-lockfile-duplicate-versions.sh"];
/** Extra audit gates added only under `strict`. */
const STRICT_AUDIT_GATES = [
	"test-determinism-audit.sh",
	"test-portability-audit.sh",
	"check-workflow-patterns.mjs",
	"verify-skills.ts",
];

/**
 * Pick the runner for a LOCAL_ONLY audit by extension. `.sh` → bash; `.ts` →
 * bun (shebang `#!/usr/bin/env bun`); `.mjs` → node (shebang
 * `#!/usr/bin/env node`). Running an `.mjs`/`.ts` under `bash` is a syntax
 * error → non-zero exit → a spurious gate failure, so the runner is chosen per
 * extension rather than uniformly `bash`. Workflow-derived gates need none of
 * this: they carry their own full command.
 */
function auditCommand(file: string): string {
	if (file.endsWith(".ts")) return `bun scripts/${file}`;
	if (file.endsWith(".mjs")) return `node scripts/${file}`;
	return `bash scripts/${file}`;
}

/**
 * Last `MAX_TAIL_LINES` lines of a failed command's output, for `detail`.
 *
 * Every spawn here already captures stdout/stderr — until now the recipe threw
 * both away and kept only the exit code, so a red package or gate reported a
 * bare number and nothing to act on. (`CiGateResult.detail` was even documented
 * as "captured tail"; nothing ever captured one.) A red main that cannot be
 * diagnosed from its own report sends the reader back to re-run the whole suite
 * by hand, which is how an intermittent failure gets waved through as a flake.
 *
 * Only populated on a NON-ZERO exit: on green there is nothing to explain, and
 * carrying every passing package's output would bloat a JSON payload that
 * callers print verbatim.
 *
 * The two streams are tailed and labelled SEPARATELY rather than concatenated —
 * they are captured as two strings, so their true interleaving is already lost
 * and inventing one would misrepresent the order. `bun test` puts the failure
 * summary on stderr and progress on stdout, so the interesting half is usually
 * the stderr block.
 */
const MAX_TAIL_LINES = 40;
const MAX_TAIL_CHARS = 4000;

function tailOf(stream: string): string {
	const lines = stream.replace(/\s+$/, "").split("\n");
	const tail = lines.slice(-MAX_TAIL_LINES).join("\n");
	return tail.length > MAX_TAIL_CHARS ? `…${tail.slice(-MAX_TAIL_CHARS)}` : tail;
}

export function failureDetail(r: { stdout: string; stderr: string; exitCode: number }): string | undefined {
	if (r.exitCode === 0) return undefined;
	const blocks: string[] = [];
	const out = tailOf(r.stdout ?? "");
	const err = tailOf(r.stderr ?? "");
	if (err) blocks.push(`stderr (last ${MAX_TAIL_LINES} lines):\n${err}`);
	if (out) blocks.push(`stdout (last ${MAX_TAIL_LINES} lines):\n${out}`);
	return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

/**
 * Spread form: `{ detail }` on failure, `{}` on success. An absent key rather
 * than an explicit `detail: undefined` keeps the JSON payload — and every
 * `toEqual` in the tests — unchanged for passing rows.
 */
function detailOf(r: { stdout: string; stderr: string; exitCode: number }): { detail?: string } {
	const detail = failureDetail(r);
	return detail ? { detail } : {};
}

/** JSON.parse that returns null on empty/garbage (never throws). */
function parseJson(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

/** Default package.json reader — the untested seam (tests inject a fake). */
async function readPackageJson(pkgDir: string): Promise<{ scripts?: Record<string, string> }> {
	const text = await Bun.file(`${pkgDir}/package.json`).text();
	const parsed = parseJson(text) as { scripts?: Record<string, string> } | null;
	return parsed ?? {};
}

/**
 * Run local CI and return a structured pass/fail outcome. Throws only when the
 * base ref cannot be resolved locally (stays offline — never auto-fetches); all
 * other failures surface as `overall: "fail"` with per-step exit codes.
 */
export async function runLocalCi(opts: CiOptions): Promise<CiOutcome> {
	const now = opts.now ?? Date.now;
	const t0 = now();
	const baseRef = opts.baseRef ?? "origin/main";
	const headRef = opts.headRef ?? "HEAD";
	const spawn = opts.spawn;
	const readPkg = opts.readPkg ?? readPackageJson;

	// 1. Verify the base ref exists LOCALLY (no network). A missing origin/main
	//    means the diff would be meaningless / the detection script would fail
	//    open to "run everything" — surface it explicitly instead.
	const verify = await spawn("git", ["rev-parse", "--verify", baseRef], { cwd: opts.repoRoot });
	if (verify.exitCode !== 0) {
		throw new Error(
			`local_ci: base ref "${baseRef}" could not be resolved (git rev-parse --verify exited ${verify.exitCode}). ` +
				`Set baseRef to an existing local ref, or fetch first (runLocalCi stays offline).`,
		);
	}

	// 2. Determine target packages: explicit list > --all > change detection.
	//    A detection ERROR (non-zero exit OR unparseable stdout) is surfaced here
	//    and short-circuits to a fail outcome — it must NEVER be coerced to an
	//    empty package set, because an empty set skips the per-package loop and a
	//    coincidentally-green gate suite would then report overall:"pass" (a
	//    false-green the agent would act on by `gh ship`-ing a broken state).
	const resolved = await resolvePackages(opts, baseRef, headRef);
	if (resolved.error) {
		return {
			overall: "fail",
			baseRef,
			headRef,
			packages: [],
			gates: [],
			elapsedMs: now() - t0,
			budgetMs: opts.budgetMs ?? 300_000,
			overBudget: now() - t0 > (opts.budgetMs ?? 300_000),
			slowest: [],
			detectionError: resolved.error,
		};
	}
	const pkgNames = resolved.packages;

	// 2b. The CI matrix is the SOURCE OF TRUTH for a package's test command.
	//     Deriving it generically (`bun run test`) silently disagrees with CI for
	//     every package whose row is special: --isolate (archify, file2md),
	//     `bun test && bun run qa` (tool-gate), knowledge-card's 3-phase ordering,
	//     build-first (workflow, webui). Without this, local_ci can report green on
	//     a package whose real CI command would fail. A package with NO row keeps
	//     the generic derivation; an unreadable workflow yields {} → all generic.
	const matrix = await (opts.readMatrix ?? readCiMatrix)(opts.repoRoot);

	// 3. Per package: typecheck + lint + test, in three phases (≤5-minute budget
	//    rule):
	//    (a) typechecks AND biome runs go in PARALLEL (both are read-only —
	//        nothing races), replacing the former N×sequential tsc wall-clock;
	//    (b) BUILD-bearing test rows (matrix/`test` commands containing `build`)
	//        run SEQUENTIALLY FIRST, in package order — they write shared dist/
	//        trees, and ci-local.sh documented that parallel runs race them;
	//    (c) the remaining (non-build) test rows run with bounded parallelism —
	//        by then no dist write is in flight, so the race is gone by
	//        construction, not by luck.
	//    Results are reassembled in the ORIGINAL package order.
	const concurrency = Math.max(1, opts.concurrency ?? 4);
	// Every per-package spawn below carries this. A hung package now fails ITSELF
	// (exit 124) instead of hanging the whole run forever.
	const timeoutMs = opts.perCommandTimeoutMs ?? 120_000;
	const byName = new Map<string, CiPackageResult>(
		pkgNames.map((name) => [name, { name, test: { exitCode: -1 } } as CiPackageResult]),
	);

	// 3a. Parallel typechecks + lints. Precedence for tsc: scripts.typecheck >
	//     scripts.check (only if it runs tsc) > skipped.
	//
	//     WHY LINT IS A PHASE AND NOT A MATRIX ROW
	//     Four packages chain `bun run check` inside their own `test` script and
	//     their matrix row is `bun run test`, so their biome ran. core-runtime and
	//     file2md declare the identical `check` script with a matrix row of bare
	//     `bun test`, which bypasses the package's `test` script entirely — so
	//     their biome ran NOWHERE, and core-runtime sat red on main for days with
	//     every gate green. Fixing the two rows would have closed those two cases
	//     and left the next package to rediscover it. Resolving the executor by
	//     SCRIPT NAME, per package, is the same shape the typecheck phase already
	//     uses, and it is why a new package with a biome.json cannot opt out by
	//     accident. Which packages must HAVE such a script is asserted separately
	//     by tests/lint-executor-coverage.test.ts.
	await mapPool(pkgNames, concurrency, async (name) => {
		if (opts.signal?.aborted) return null;
		const pkgDir = `${opts.repoRoot}/bun-apps/${name}`;
		const result = byName.get(name)!;
		const scripts = (await readPkg(pkgDir)).scripts ?? {};
		const t0 = now();
		if (typeof scripts.typecheck === "string") {
			const r = await spawn("bun", ["run", "typecheck"], { cwd: pkgDir, timeoutMs });
			result.typecheck = { exitCode: r.exitCode, durationMs: now() - t0, ...detailOf(r) };
		} else if (typeof scripts.check === "string" && /tsc/.test(scripts.check)) {
			const r = await spawn("bun", ["run", "check"], { cwd: pkgDir, timeoutMs });
			result.typecheck = { exitCode: r.exitCode, durationMs: now() - t0, ...detailOf(r) };
		} else {
			result.typecheck = { exitCode: -1, skipped: true, note: "no tsc key" };
		}
		// Biome, in the same read-only pass. Precedence: scripts.check (only if it
		// runs biome) > scripts.lint (only if it runs biome) > skipped. `check` is
		// preferred over `lint` deliberately: `biome lint .` reports NEITHER format
		// nor organizeImports, which is what every drift found so far has been —
		// resolving to `lint` would produce a green gate over a red `check`.
		const tLint = now();
		if (typeof scripts.check === "string" && /biome/.test(scripts.check)) {
			const r = await spawn("bun", ["run", "check"], { cwd: pkgDir, timeoutMs });
			result.lint = { exitCode: r.exitCode, durationMs: now() - tLint, ...detailOf(r) };
		} else if (typeof scripts.lint === "string" && /biome/.test(scripts.lint)) {
			const r = await spawn("bun", ["run", "lint"], { cwd: pkgDir, timeoutMs });
			result.lint = { exitCode: r.exitCode, durationMs: now() - tLint, ...detailOf(r) };
		} else {
			result.lint = { exitCode: -1, skipped: true, note: "no biome key" };
		}
		return null;
	});

	// 3b/3c. Tests. Precedence: the package's CI matrix row > its `test` script >
	//        nothing (-1, counts as pass). A matrix row is run through `bash -c`
	//        because the rows are shell COMMANDS, not single argv vectors
	//        (`bun test && bun run qa`, knowledge-card's 3-phase chain,
	//        `bun run build && bun test`) — the same way scripts/ci-local.sh
	//        executes them. NB: ci-local.sh additionally exports CI=true;
	//        local_ci deliberately does not, preserving its own pre-existing
	//        behavior — locally the machine-coupled tests SHOULD run, that's the point.
	interface TestPlan {
		name: string;
		pkgDir: string;
		/** True when the command WRITES build artifacts (runs `build`) — sequential phase. */
		builds: boolean;
		run: () => Promise<void>;
	}
	const plans: TestPlan[] = [];
	for (const name of pkgNames) {
		const pkgDir = `${opts.repoRoot}/bun-apps/${name}`;
		const scripts = (await readPkg(pkgDir)).scripts ?? {};
		const result = byName.get(name)!;
		const matrixCmd = matrix[name];
		const cmdText =
			typeof matrixCmd === "string" ? matrixCmd : typeof scripts.test === "string" ? scripts.test : null;
		const plan: TestPlan = {
			name,
			pkgDir,
			builds: cmdText !== null && /\bbuild\b/.test(cmdText),
			run: async () => {
				const t0 = now();
				const timedOutNote = `HUNG — killed after ${timeoutMs}ms (exit ${SPAWN_TIMEOUT_EXIT_CODE}); this is a hang, not a test failure`;
				if (typeof matrixCmd === "string") {
					const r = await spawn("bash", ["-c", matrixCmd], { cwd: pkgDir, timeoutMs });
					result.test = {
						exitCode: r.exitCode,
						source: "matrix",
						command: matrixCmd,
						durationMs: now() - t0,
						...(r.exitCode === SPAWN_TIMEOUT_EXIT_CODE ? { note: timedOutNote } : {}),
						...detailOf(r),
					};
				} else if (typeof scripts.test === "string") {
					const r = await spawn("bun", ["run", "test"], { cwd: pkgDir, timeoutMs });
					result.test = {
						exitCode: r.exitCode,
						source: "package-script",
						durationMs: now() - t0,
						...(r.exitCode === SPAWN_TIMEOUT_EXIT_CODE ? { note: timedOutNote } : {}),
						...detailOf(r),
					};
				} else {
					result.test = { exitCode: -1, note: "no test script" };
				}
			},
		};
		plans.push(plan);
	}

	// 3b. Sequential-first rows: BUILD-bearing commands (dist writes serialize)
	//     and pi-agent's own suite (the one repo package whose test run makes
	//     the Bun runtime rewrite bun-apps/node_modules/@repo/* symlinks to a
	//     dangling form — running it in isolation FIRST means the rewrite
	//     happens before any other package resolves @repo/*, and the heal
	//     below repairs it before the parallel phase starts).
	const sequentialFirst = (p: TestPlan) => p.builds || p.name === "pi-agent";
	for (const plan of plans.filter(sequentialFirst)) {
		if (opts.signal?.aborted) break;
		await plan.run();
	}
	// Heal any @repo/* workspace link the sequential phase left dangling (the
	// Bun-runtime rewrite above) so the parallel phase resolves cleanly. Only
	// needed when pi-agent's own suite ran — it is the sole link-breaker — which
	// also keeps the heal spawn out of unrelated runs' spawn sequences.
	if (plans.some((p) => p.name === "pi-agent")) {
		await healWorkspaceLinks(spawn, opts.repoRoot);
	}
	// 3c. Non-build rows, bounded parallelism.
	await mapPool(
		plans.filter((p) => !sequentialFirst(p)),
		concurrency,
		async (plan) => {
			if (opts.signal?.aborted) return null;
			await plan.run();
			return null;
		},
	);

	const packages = pkgNames.map((n) => byName.get(n)!);

	// 4. Gates (default on) + info-only schema-cost.
	//    The gate list is DERIVED from the workflow's `regression-gates` job —
	//    never hand-written here. A hardcoded list drifted into running 2 of the
	//    job's 14 steps, so eight blocking structural guards (dep-direction, ADR,
	//    seam, routing, config-parity, ci-workflow, package-scripts, --strict
	//    portability) never ran under the tool await_pr_merge gates the merge on.
	const gates: CiGateResult[] = [];
	let gateError: string | undefined;
	let schemaCost: CiOutcome["schemaCost"];
	const includeGates = opts.includeGates !== false;
	if (includeGates && !opts.signal?.aborted) {
		const parsed = await (opts.readGates ?? readCiGates)(opts.repoRoot);
		if (parsed.error) {
			// Fail closed. Running zero gates and reporting "pass" is the false-green
			// this whole path exists to prevent.
			gateError = parsed.error;
		} else {
			// Every step is run as a SHELL command in its own working-directory: the
			// rows are commands, not argv vectors (`bun run test:deps`), and a
			// `bun-apps` row fails at the repo root for reasons unrelated to the guard.
			const specs = parsed.gates.map((g) => ({ name: g.name, run: g.run, cwd: g.cwd }));
			if (opts.strict) {
				// The audits CI has no step for — otherwise nothing ever runs them.
				for (const file of LOCAL_ONLY_AUDITS) specs.push({ name: file, run: auditCommand(file), cwd: "." });
			}
			for (const spec of specs) {
				if (opts.signal?.aborted) break;
				const cwd = spec.cwd === "." ? opts.repoRoot : `${opts.repoRoot}/${spec.cwd}`;
				const r = await spawn("bash", ["-c", spec.run], { cwd });
				gates.push({ name: spec.name, exitCode: r.exitCode, ...detailOf(r) });
			}
			// oneshot-smoke — the ONE gate hand-added beside the workflow-derived set,
			// and it can never have a workflow home: it boots the real pi-agent CLI,
			// which needs this machine's providers/credentials (remote CI — disabled
			// anyway — has neither; there it would classify as provider-unavailable
			// SKIP and guard nothing). Like LOCAL_ONLY_AUDITS it is local-only, but
			// unlike them it is ALWAYS on, not `strict`-only: its entire purpose is
			// catching a boot hang (hermes startup syncMarkdownMemories / surrealdb
			// wedge, 2026-08-15) before a session pays 6+ minutes for it, and its
			// adaptive state (6h pass-cache / 24h canary) keeps steady-state cost at
			// one sha256. Env override: DEVOPS_ONESHOT_SMOKE=force|skip.
			if (!opts.signal?.aborted) {
				const smoke = await (opts.runOneshotSmoke ?? runOneshotSmoke)({
					repoRoot: opts.repoRoot,
					spawn,
					now,
				});
				if (smoke) {
					gates.push({
						name: ONESHOT_SMOKE_GATE_NAME,
						exitCode: smoke.exitCode,
						note: smoke.note,
						...(smoke.detail ? { detail: smoke.detail } : {}),
					});
				}
				// Change-triggered launcher e2e — the one remaining PI_AGENT_E2E-
				// gated assertion (e2e-launcher's `symlink resolution` block, which
				// spawns the real src/cli.ts). The workflow-derived gates above
				// boot the deployed artifact, but a PI_AGENT_E2E-gated block is
				// invisible to a plain `bun test` and so to the package matrix —
				// the #1305 class. Runs ONLY when the diff touches a
				// launcher/entry-sensitive path. A failed `git diff` skips the gate
				// (fail-open): the unconditional artifact gate above already ran,
				// and a base-ref that cannot diff was already rejected at step 1.
				if (!opts.signal?.aborted) {
					const diff = await spawn("git", ["diff", "--name-only", baseRef, headRef], {
						cwd: opts.repoRoot,
					});
					if (diff.exitCode === 0) {
						const files = diff.stdout
							.split("\n")
							.map((l) => l.trim())
							.filter(Boolean);
						if (shouldRunDeployE2e(files)) {
							const r = await spawn("bash", ["-c", DEPLOY_E2E_COMMAND], {
								cwd: `${opts.repoRoot}/bun-apps/pi-agent`,
								// Bundle build + suite ≈ 20-40s; 240s only kills a HANG.
								timeoutMs: 240_000,
							});
							gates.push({
								name: DEPLOY_E2E_GATE_NAME,
								exitCode: r.exitCode,
								...detailOf(r),
							});
						}
					}
				}
			}
		}
		// schema-cost is ALWAYS info-only — a regression here must not block a merge.
		// Imported (not spawned) so the check runs in-process; its internal
		// tools-metrics spawn still goes through the injectable SpawnFn seam.
		const sc = await runSchemaCostCheck({
			repoRoot: opts.repoRoot,
			spawn,
			log: opts.log,
			baseline: opts.schemaCostBaseline,
		});
		schemaCost = { exitCode: sc.exitCode, note: "info-only — never affects overall" };
	}

	// 5. Aggregate. overall = fail iff any non-skipped typecheck failed, any
	//    non-skipped lint failed, any test
	//    failed (exit not in {0=pass, -1=no-test-script}), any gate failed, or the
	//    gate job could not be read at all. schemaCost never participates.
	//    Every gate is blocking: GitHub fails a job on any failed step and
	//    `regression-gates` carries no continue-on-error, so a step's "warn-only"
	//    naming is encoded in the SCRIPT's exit code, not in a per-gate flag here.
	const typecheckFailed = packages.some((p) => !!p.typecheck && !p.typecheck.skipped && p.typecheck.exitCode !== 0);
	const lintFailed = packages.some((p) => !!p.lint && !p.lint.skipped && p.lint.exitCode !== 0);
	const testFailed = packages.some((p) => p.test.exitCode !== 0 && p.test.exitCode !== -1);
	const gateFailed = gates.some((g) => g.exitCode !== 0);
	const overall: "pass" | "fail" =
		typecheckFailed || lintFailed || testFailed || gateFailed || !!gateError ? "fail" : "pass";

	const elapsedMs = now() - t0;
	const budgetMs = opts.budgetMs ?? 300_000;
	const slowest = packages
		.map((p) => ({
			name: p.name,
			durationMs: (p.typecheck?.durationMs ?? 0) + (p.lint?.durationMs ?? 0) + (p.test.durationMs ?? 0),
		}))
		.sort((a, b) => b.durationMs - a.durationMs)
		.slice(0, 5);

	return {
		overall,
		baseRef,
		headRef,
		packages,
		gates,
		schemaCost,
		elapsedMs,
		budgetMs,
		overBudget: elapsedMs > budgetMs,
		slowest,
		...(gateError ? { gateError } : {}),
	};
}

/** Resolve the target package set per the precedence rules (detection may run). */
async function resolvePackages(
	opts: CiOptions,
	baseRef: string,
	headRef: string,
): Promise<{ packages: string[]; error?: string }> {
	if (Array.isArray(opts.packages)) return { packages: opts.packages };
	const detect = opts.detectChangedPackages ?? computeChangedPackages;
	// A detection ERROR is surfaced here and short-circuits to a fail outcome —
	// it must NEVER be coerced to an empty package set, because an empty set
	// skips the per-package loop and a coincidentally-green gate suite would then
	// report overall:"pass" (a false-green the agent would act on by `gh ship`-ing
	// a broken state). computeChangedPackages only throws on a genuine I/O
	// failure (its own fail-open cases return all-true instead); tests simulate a
	// detection failure by injecting a detect fn that throws.
	let map: ChangedPackagesMap;
	try {
		map = opts.all
			? await detect({ repoRoot: opts.repoRoot, all: true, spawn: opts.spawn })
			: await detect({ repoRoot: opts.repoRoot, baseRef, headRef, spawn: opts.spawn });
	} catch (e) {
		return { packages: [], error: `changed-packages detection failed: ${(e as Error).message}` };
	}
	if (opts.all) return { packages: Object.keys(map) };
	return {
		packages: Object.entries(map)
			.filter(([, v]) => v === true)
			.map(([k]) => k),
	};
}
