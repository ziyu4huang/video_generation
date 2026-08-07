/**
 * runLocalCi — the PURE orchestration behind the `local_ci` tool. It mirrors
 * what remote CI would do, but LOCALLY and OFFLINE (no network): typecheck +
 * tests scoped to the packages affected vs origin/main, plus the repo's quality
 * gates (file-size guard, lockfile-duplicate guard, optional audit gates, and an
 * info-only schema-cost check). Returns a STRUCTURED pass/fail so the agent can
 * decide "safe to merge" without eyeballing terminal noise.
 *
 * The recipe itself never touches the shell — every process spawn goes through
 * the injectable `SpawnFn` seam (src/spawn.ts), so the whole flow is fully
 * testable with a recording fake and has zero coupling to the real filesystem /
 * git state. The live `SpawnFn` (`createLiveSpawn`) is the only untested seam.
 *
 * Detection + gate scripts are the SAME committed scripts remote CI uses
 * (scripts/ci-changed-packages.sh, scripts/ci-file-size-guard.sh, …), so a green
 * run here is the local proxy for a green remote run — the rationale for the
 * repo-wide "never wait for remote CI; self-verify then `gh ship`" rule.
 */
import type { SpawnFn } from "./spawn.js";

export interface CiPackageResult {
	name: string;
	typecheck?: { exitCode: number; skipped?: boolean; note?: string };
	test: { exitCode: number; note?: string };
}

export interface CiGateResult {
	name: string;
	exitCode: number;
	blocking: boolean;
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
}

export interface CiOptions {
	repoRoot: string;
	/** Base ref to diff against. Default "origin/main". Must already exist locally. */
	baseRef?: string;
	/** Head ref. Default "HEAD". */
	headRef?: string;
	/** Explicit package list → skip change detection entirely. */
	packages?: string[];
	/** Run every bun-apps/* package (ci-changed-packages.sh --all). */
	all?: boolean;
	/** Add the audit gates (determinism / portability / workflow-patterns / verify-skills). */
	strict?: boolean;
	/** Run the gate suite. Default true. */
	includeGates?: boolean;
	/** Injectable process spawn (live: src/spawn.ts createLiveSpawn; tests: fake). */
	spawn: SpawnFn;
	/** Abort signal; the recipe stops spawning further commands when fired. */
	signal?: AbortSignal;
	/** Injectable package.json reader. Default: read <pkgDir>/package.json. */
	readPkg?: (pkgDir: string) => Promise<{ scripts?: Record<string, string> }>;
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
 * Pick the runner for a scripts/<gate> by extension. `.sh` → bash (matches
 * .github/workflows/ci.yml); `.ts` → bun (shebang `#!/usr/bin/env bun`,
 * documented `bun scripts/…`); `.mjs` → node (shebang `#!/usr/bin/env node`,
 * documented `node scripts/…`). NB: running an `.mjs`/`.ts` under `bash` would
 * be a hard failure (syntax error → non-zero exit → spurious gate failure), so
 * the runner is chosen per extension rather than uniformly `bash`.
 */
function dispatchGate(file: string): { cmd: string; args: string[] } {
	if (file.endsWith(".ts")) return { cmd: "bun", args: [`scripts/${file}`] };
	if (file.endsWith(".mjs")) return { cmd: "node", args: [`scripts/${file}`] };
	return { cmd: "bash", args: [`scripts/${file}`] };
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
	const t0 = Date.now();
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
	const pkgNames = await resolvePackages(opts, baseRef, headRef, spawn);

	// 3. Per package: typecheck (by precedence) + test.
	const packages: CiPackageResult[] = [];
	for (const name of pkgNames) {
		if (opts.signal?.aborted) break;
		const pkgDir = `${opts.repoRoot}/bun-apps/${name}`;
		const scripts = (await readPkg(pkgDir)).scripts ?? {};
		const result: CiPackageResult = { name, test: { exitCode: -1 } };

		// Typecheck precedence: scripts.typecheck > scripts.check (only if it runs tsc).
		if (typeof scripts.typecheck === "string") {
			const r = await spawn("bun", ["run", "typecheck"], { cwd: pkgDir });
			result.typecheck = { exitCode: r.exitCode };
		} else if (typeof scripts.check === "string" && /tsc/.test(scripts.check)) {
			const r = await spawn("bun", ["run", "check"], { cwd: pkgDir });
			result.typecheck = { exitCode: r.exitCode };
		} else {
			result.typecheck = { exitCode: -1, skipped: true, note: "no tsc key" };
		}

		// Test. A package with no `test` script → -1 (counts as pass — nothing to run).
		if (typeof scripts.test === "string") {
			const r = await spawn("bun", ["run", "test"], { cwd: pkgDir });
			result.test = { exitCode: r.exitCode };
		} else {
			result.test = { exitCode: -1, note: "no test script" };
		}
		packages.push(result);
	}

	// 4. Gates (default on) + info-only schema-cost.
	const gates: CiGateResult[] = [];
	let schemaCost: CiOutcome["schemaCost"];
	const includeGates = opts.includeGates !== false;
	if (includeGates && !opts.signal?.aborted) {
		const specs: GateSpec[] = BLOCKING_GATES_V1.map((file) => ({ file, ...dispatchGate(file), blocking: true }));
		if (opts.strict) {
			for (const file of STRICT_AUDIT_GATES) specs.push({ file, ...dispatchGate(file), blocking: true });
		}
		for (const spec of specs) {
			if (opts.signal?.aborted) break;
			const r = await spawn(spec.cmd, spec.args, { cwd: opts.repoRoot });
			gates.push({ name: spec.file, exitCode: r.exitCode, blocking: spec.blocking });
		}
		// schema-cost is ALWAYS info-only — a regression here must not block a merge.
		const sc = await spawn("bun", ["scripts/check-schema-cost.ts"], { cwd: opts.repoRoot });
		schemaCost = { exitCode: sc.exitCode, note: "info-only — never affects overall" };
	}

	// 5. Aggregate. overall = fail iff any non-skipped typecheck failed, any test
	//    failed (exit not in {0=pass, -1=no-test-script}), or any BLOCKING gate
	//    failed. schemaCost never participates.
	const typecheckFailed = packages.some((p) => !!p.typecheck && !p.typecheck.skipped && p.typecheck.exitCode !== 0);
	const testFailed = packages.some((p) => p.test.exitCode !== 0 && p.test.exitCode !== -1);
	const gateFailed = gates.some((g) => g.blocking && g.exitCode !== 0);
	const overall: "pass" | "fail" = typecheckFailed || testFailed || gateFailed ? "fail" : "pass";

	return {
		overall,
		baseRef,
		headRef,
		packages,
		gates,
		schemaCost,
		elapsedMs: Date.now() - t0,
	};
}

/** Resolve the target package set per the precedence rules (detection may spawn). */
async function resolvePackages(
	opts: CiOptions,
	baseRef: string,
	headRef: string,
	spawn: SpawnFn,
): Promise<string[]> {
	if (Array.isArray(opts.packages)) return opts.packages;
	if (opts.all) {
		const r = await spawn("bash", ["scripts/ci-changed-packages.sh", "--all"], { cwd: opts.repoRoot });
		return Object.keys((parseJson(r.stdout) ?? {}) as Record<string, unknown>);
	}
	const r = await spawn("bash", ["scripts/ci-changed-packages.sh", baseRef, headRef], { cwd: opts.repoRoot });
	const obj = (parseJson(r.stdout) ?? {}) as Record<string, unknown>;
	return Object.entries(obj)
		.filter(([, v]) => v === true)
		.map(([k]) => k);
}
