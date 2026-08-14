/**
 * deploy-tool.ts — pi_deploy: build argv, guard outDir, run deploy.ts, parse
 * its output into a structured result. The deploy itself is delegated to
 * scripts/deploy.ts (single source of truth); this file only orchestrates +
 * parses.
 */
import { buildDeployArgv, type DeployMode, type DeployParams } from "./deploy-argv.ts";
import { assertSafeOutDir, resolvePiAgentDir, runScript, tailOutput } from "./deploy-run.ts";
import { resolve } from "node:path";

const DEPLOY_TIMEOUT_MS = 5 * 60 * 1000;

export interface ParsedDeploy {
	piAgentJsBytes?: number;
	built: number;
	failed: string[];
}

/** Pure: extract pi-agent.js size, ext-bundles built count, and failing names. */
export function parseDeployOutput(text: string): ParsedDeploy {
	const sizeMatch = text.match(/pi-agent\.js\s+\(([\d.]+)\s*(MB|KB|B)\)/);
	let piAgentJsBytes: number | undefined;
	if (sizeMatch) {
		const n = parseFloat(sizeMatch[1]!);
		const unit = sizeMatch[2];
		piAgentJsBytes = unit === "MB" ? n * 1e6 : unit === "KB" ? n * 1e3 : n;
	}
	const builtMatch = text.match(/\((\d+)\s+built,/);
	const built = builtMatch ? parseInt(builtMatch[1]!, 10) : 0;
	// Failing extension lines look like: "✗ <name>: <message>"
	const failed = [...text.matchAll(/✗\s+([a-zA-Z0-9_.-]+):/g)].map((m) => m[1]!);
	return { piAgentJsBytes, built, failed };
}

export interface DeployResult {
	ok: boolean;
	mode: DeployMode;
	outDir: string;
	piAgentJsBytes?: number;
	extBundles: { built: number; failed: string[] };
	exitCode: number;
	logPath: string;
	errorTail?: string;
}

export interface DeployRunDeps {
	resolveDir?: typeof resolvePiAgentDir;
	run?: typeof runScript;
}

/** Run deploy.ts for the given params. Failures are { ok:false }; the only throw
 *  is assertSafeOutDir on an outDir outside <repo>/dist/ or $TMPDIR (fail-fast),
 *  which the tool's execute() try/catch turns into a tool error. */
export async function runDeploy(
	params: DeployParams,
	deps: DeployRunDeps = {},
): Promise<DeployResult> {
	const mode: DeployMode = params.mode ?? "bundle";
	const resolveDir = deps.resolveDir ?? resolvePiAgentDir;
	const run = deps.run ?? runScript;

	const piAgentDir = resolveDir();
	const outDir = params.outDir ?? "(deploy default: <repo>/dist/pi-agent)";
	if (!piAgentDir) {
		return {
			ok: false,
			mode,
			outDir,
			extBundles: { built: 0, failed: [] },
			exitCode: -1,
			logPath: "",
			errorTail:
				"Could not locate the source pi-agent dir (pi-agent-ext-devops/scripts/deploy.ts not found). " +
				"Run pi-agent from the repo, or set PI_AGENT_DIR=<repo>/bun-apps/pi-agent.",
		};
	}
	if (params.outDir) {
		const repoRoot = resolve(piAgentDir, "..", "..");
		assertSafeOutDir(params.outDir, repoRoot);
	}

	const argv = buildDeployArgv(params);
	const res = await run({
		cmd: "bun",
		// deploy.ts moved to pi-agent-ext-devops/scripts/, but still requires
		// cwd == the pi-agent package dir (see assertCorrectCwd in deploy.ts).
		args: ["../pi-agent-ext-devops/scripts/deploy.ts", ...argv],
		cwd: piAgentDir,
		timeoutMs: DEPLOY_TIMEOUT_MS,
		logName: "pi-deploy",
	});
	const parsed = parseDeployOutput(res.output);
	const ok = res.exitCode === 0 && !res.timedOut && parsed.failed.length === 0;
	return {
		ok,
		mode,
		outDir: params.outDir ?? "(deploy default)",
		piAgentJsBytes: parsed.piAgentJsBytes,
		extBundles: { built: parsed.built, failed: parsed.failed },
		exitCode: res.exitCode,
		logPath: res.logPath,
		errorTail: ok ? undefined : (res.timedOut ? "deploy exceeded 5min timeout" : tailOutput(res.output)),
	};
}
