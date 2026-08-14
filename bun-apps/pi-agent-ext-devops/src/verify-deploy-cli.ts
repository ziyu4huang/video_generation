#!/usr/bin/env bun
/**
 * verify-deploy-cli — bin `devops-verify-deploy`: one-shot gate that proves the
 * build/deploy pipeline is green (the TS port of the deleted root
 * `scripts/verify-deploy.sh`, final part of the devops-scripts unification).
 *
 * Runs the chain a deploy depends on, in order — now composing the NOW-LOCAL
 * devops scripts (`bun-apps/pi-agent-ext-devops/scripts/`):
 *   1. bun install          (fresh node_modules — the #1 silent-break cause)
 *   2. quick tests          (`run-test.sh quick` — pure-logic gate, no GPU/model)
 *   3. bundle deploy        (`deploy.ts <tmp-out> --bundle` from the pi-agent
 *                            cwd — proves workspace imports resolve. Replaces
 *                            the old bash's dead `build.ts` step, which never
 *                            existed, with the real bundle deploy.)
 *   4. smoke                (boot the DEPLOYED artifact from the deploy dir —
 *                            `pi-agent.js --help` + the `run.sh` launcher)
 *   5. foreign-cwd          (boot the deployed artifact from /tmp — any
 *                            cwd-coupled path resolution breaks loudly. The
 *                            old bash booted from `/`; no zero-writes assertion
 *                            existed there, so none is ported.)
 *
 * The tmp deploy dir is removed on exit unless `--keep-deploy`.
 *
 * CONTRACT
 *   - `--skip-install`       skip step 1 (reuse current node_modules)
 *   - `--keep-deploy`        keep the tmp deploy dir (path echoed in the JSON)
 *   - `--repo-root <path>`   default: the repo this file lives in
 *   - `--help` / `-h`        usage (exit 0)
 *   - stdout: `{steps, overall, commands, elapsedMs}` as JSON (nothing else)
 *   - exit 0 all steps green; 1 any step failed; 2 usage error.
 *   - throw-free: a throwing spawn (ENOENT, crash) is recorded as a failed
 *     step, never propagated.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLiveSpawn, type SpawnFn } from "./spawn.js";

export interface VerifyDeployStep {
	name: string;
	ok: boolean;
	exitCode: number;
	note?: string;
}

export interface VerifyDeployCliResult {
	exitCode: number;
	/** Exactly what belongs on stdout (empty on a usage error / --help). */
	stdout: string;
	/** Diagnostics / usage — never mixed into stdout. */
	stderr: string;
}

export const VERIFY_DEPLOY_USAGE = [
	"usage: verify-deploy-cli.ts [--skip-install] [--keep-deploy] [--repo-root <path>]",
	"",
	"One-shot gate for the build/deploy pipeline: bun install → quick tests →",
	"bundle deploy to a tmp dir → smoke the deployed artifact → foreign-cwd boot.",
	"Prints {steps, overall, commands, elapsedMs} as JSON on stdout. Exit 0 when",
	"every step is green, 1 when any step failed, 2 on a usage error.",
	"Options:",
	"  --skip-install      skip the `bun install` step (reuse node_modules)",
	"  --keep-deploy       keep the tmp deploy dir (path echoed in the JSON)",
	"  --repo-root <path>  default: the repo this file lives in",
].join("\n");

/** Repo root inferred from this file's location (`<root>/bun-apps/<pkg>/src/`). */
export function defaultRepoRoot(): string {
	return path.resolve(import.meta.dir, "..", "..", "..");
}

export interface ParsedVerifyDeployArgs {
	skipInstall: boolean;
	keepDeploy: boolean;
	repoRoot?: string;
}

/** Pure argv → flags (or a usage-error message). Exported for tests. */
export function parseVerifyDeployArgs(
	argv: string[],
): { ok: true; args: ParsedVerifyDeployArgs } | { ok: false; message: string } {
	let skipInstall = false;
	let keepDeploy = false;
	let repoRoot: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--skip-install") {
			skipInstall = true;
		} else if (a === "--keep-deploy") {
			keepDeploy = true;
		} else if (a === "--repo-root") {
			const v = argv[++i];
			if (v === undefined || v === "") {
				return { ok: false, message: "--repo-root needs a value" };
			}
			repoRoot = v;
		} else if (a === "-h" || a === "--help") {
			return { ok: false, message: "" }; // handled by the caller via exitCode 0
		} else if (a.startsWith("-")) {
			return { ok: false, message: `unknown flag: ${a}` };
		} else {
			return { ok: false, message: `unexpected positional argument: ${a}` };
		}
	}
	return { ok: true, args: { skipInstall, keepDeploy, repoRoot } };
}

export interface VerifyDeployDeps {
	/** Injectable spawn (tests record calls instead of running real builds). */
	spawn?: SpawnFn;
	repoRoot?: string;
	/** Injectable tmp-dir factory / cleanup — the fs seam for offline tests. */
	mkTempDir?: () => string;
	removeDir?: (dir: string) => void;
}

/**
 * Pure-ish orchestration behind the argv wrapper. All real I/O goes through the
 * injectable `spawn` / `mkTempDir` / `removeDir` seams; the live entry point
 * below supplies the real ones. Never throws — a failed/throwing step is
 * recorded and stops the chain (mirroring the bash's fail-loudly-on-first-break).
 */
export async function runVerifyDeployCli(
	argv: string[],
	deps: VerifyDeployDeps = {},
): Promise<VerifyDeployCliResult> {
	const parsed = parseVerifyDeployArgs(argv);
	if (!parsed.ok) {
		if (argv.includes("-h") || argv.includes("--help")) {
			return { exitCode: 0, stdout: "", stderr: VERIFY_DEPLOY_USAGE };
		}
		return { exitCode: 2, stdout: "", stderr: `${parsed.message}\n${VERIFY_DEPLOY_USAGE}` };
	}
	const { skipInstall, keepDeploy } = parsed.args;
	const repoRoot = path.resolve(parsed.args.repoRoot ?? deps.repoRoot ?? defaultRepoRoot());
	const spawn = deps.spawn ?? createLiveSpawn(repoRoot);
	const mkTempDir = deps.mkTempDir ?? (() => mkdtempSync(path.join(tmpdir(), "devops-verify-deploy-")));
	const removeDir = deps.removeDir ?? ((dir: string) => rmSync(dir, { recursive: true, force: true }));

	const startedAt = Date.now();
	const steps: VerifyDeployStep[] = [];
	const commands: string[] = [];
	const extScripts = path.join(repoRoot, "bun-apps", "pi-agent-ext-devops", "scripts");
	const piAgentDir = path.join(repoRoot, "bun-apps", "pi-agent");

	/** Run one command as one step; record it; return its ok-ness. Throw-free. */
	const runStep = async (
		name: string,
		cmd: string,
		args: string[],
		cwd: string,
		note?: string,
	): Promise<boolean> => {
		commands.push(`(cwd: ${cwd}) ${cmd} ${args.join(" ")}`);
		try {
			const r = await spawn(cmd, args, { cwd });
			const ok = r.exitCode === 0;
			steps.push({ name, ok, exitCode: r.exitCode, ...(note ? { note } : {}) });
			return ok;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			steps.push({ name, ok: false, exitCode: -1, note: `spawn error: ${msg}` });
			return false;
		}
	};

	/** Run several probes as ONE step (first failure fails the step, chain stops). */
	const runProbes = async (
		name: string,
		probes: { cmd: string; args: string[]; cwd: string }[],
		note?: string,
	): Promise<boolean> => {
		for (const p of probes) {
			const ok = await runStep(name, p.cmd, p.args, p.cwd);
			if (!ok) return false;
		}
		// All probes green — collapse them into one green step.
		steps.splice(steps.length - probes.length, probes.length, { name, ok: true, exitCode: 0, ...(note ? { note } : {}) });
		return true;
	};

	let deployDir = "";
	try {
		// ── 1. fresh node_modules ─────────────────────────────────────────────
		if (skipInstall) {
			steps.push({ name: "install", ok: true, exitCode: 0, note: "skipped (--skip-install)" });
		} else if (!(await runStep("install", "bun", ["install"], path.join(repoRoot, "bun-apps"), "fresh node_modules"))) {
			return finish(1);
		}

		// ── 2. quick tests (run-test.sh resolves its own paths; it cds itself) ─
		if (
			!(await runStep(
				"quick-tests",
				"bash",
				[path.join(extScripts, "run-test.sh"), "quick"],
				extScripts,
				"pi-agent quick tier — no GPU/model",
			))
		) {
			return finish(1);
		}

		// ── 3. bundle deploy to a tmp dir (deploy.ts REQUIRES the pi-agent cwd) ─
		try {
			deployDir = mkTempDir();
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			steps.push({ name: "bundle-deploy", ok: false, exitCode: -1, note: `tmp dir error: ${msg}` });
			return finish(1);
		}
		if (
			!(await runStep(
				"bundle-deploy",
				"bun",
				[path.join(extScripts, "deploy.ts"), deployDir, "--bundle", "--no-freeze"],
				piAgentDir,
				"proves all workspace imports resolve",
			))
		) {
			return finish(1);
		}

		// ── 4. smoke: boot the deployed artifact (both entry modes) ───────────
		if (
			!(await runProbes("smoke", [
				{ cmd: "bun", args: [path.join(deployDir, "pi-agent.js"), "--help"], cwd: deployDir },
				{ cmd: "bash", args: [path.join(deployDir, "run.sh"), "--help"], cwd: deployDir },
			], "deployed artifact boots + responds"))
		) {
			return finish(1);
		}

		// ── 5. foreign-cwd: boot from /tmp — cwd-coupled paths break loudly ───
		if (
			!(await runProbes("foreign-cwd", [
				{ cmd: "bun", args: [path.join(deployDir, "pi-agent.js"), "--help"], cwd: tmpdir() },
				{ cmd: "bun", args: [path.join(deployDir, "pi-agent.js"), "cli", "version"], cwd: tmpdir() },
			], "boots from a foreign cwd (no repo / node_modules / .pi)"))
		) {
			return finish(1);
		}

		return finish(0);
	} finally {
		if (deployDir && !keepDeploy) {
			try {
				removeDir(deployDir);
			} catch {
				// Cleanup failure must not turn a green run red (throw-free).
			}
		}
	}

	/** Serialize the outcome. `overall` + exit code derive from the steps. */
	function finish(exitCode: number): VerifyDeployCliResult {
		const overall = steps.every((s) => s.ok) ? "pass" : "fail";
		const payload: Record<string, unknown> = {
			steps,
			overall,
			commands,
			elapsedMs: Date.now() - startedAt,
		};
		if (keepDeploy && deployDir) payload.deployDir = deployDir;
		return { exitCode, stdout: JSON.stringify(payload, null, 2), stderr: "" };
	}
}

if (import.meta.main) {
	const res = await runVerifyDeployCli(Bun.argv.slice(2));
	if (res.stderr) process.stderr.write(`${res.stderr}\n`);
	if (res.stdout) process.stdout.write(`${res.stdout}\n`);
	process.exit(res.exitCode);
}
