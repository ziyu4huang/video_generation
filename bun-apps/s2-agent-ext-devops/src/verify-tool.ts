/**
 * verify-tool.ts — verify_pi_agent_deploy: build argv, run run-test.sh at a chosen tier,
 * parse its step summary. run-test.sh stays the single source of truth.
 */
import { buildVerifyArgv, type VerifyParams, type VerifyTier } from "./deploy-argv.ts";
import { resolvePiAgentDir, runScript, tailOutput } from "./deploy-run.ts";
import { resolve } from "node:path";

const TIER_TIMEOUT_MS: Record<VerifyTier, number> = {
	quick: 60_000,
	medium: 5 * 60_000,
	full: 15 * 60_000,
};

export interface VerifyStep {
	name: string;
	passed: boolean;
	seconds: number;
}

/** Pure: strip ANSI, extract "(Ns)" step lines as ✓/✗ → steps. */
export function parseVerifyOutput(text: string): VerifyStep[] {
	const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
	const steps: VerifyStep[] = [];
	for (const m of clean.matchAll(/([✓✗])\s+(.+?)\s{2,}\((\d+)s\)/g)) {
		steps.push({
			name: m[2]!.trim(),
			passed: m[1] === "✓",
			seconds: parseInt(m[3]!, 10),
		});
	}
	return steps;
}

export interface VerifyResult {
	ok: boolean;
	tier: VerifyTier;
	steps: VerifyStep[];
	exitCode: number;
	logPath: string;
	errorTail?: string;
}

export interface VerifyRunDeps {
	resolveDir?: typeof resolvePiAgentDir;
	run?: typeof runScript;
}

/** Run run-test.sh at the chosen tier. Failures are { ok:false }, never throws. */
export async function runVerify(
	params: VerifyParams,
	deps: VerifyRunDeps = {},
): Promise<VerifyResult> {
	const tier: VerifyTier = params.tier ?? "medium";
	const resolveDir = deps.resolveDir ?? resolvePiAgentDir;
	const run = deps.run ?? runScript;

	const piAgentDir = resolveDir();
	if (!piAgentDir) {
		return {
			ok: false,
			tier,
			steps: [],
			exitCode: -1,
			logPath: "",
			errorTail:
				"Could not locate the source s2-agent dir (s2-agent-ext-devops/scripts/run-test.sh not found). " +
				"Run s2-agent from the repo, or set PI_AGENT_DIR=<repo>/bun-apps/s2-agent.",
		};
	}

	const argv = buildVerifyArgv(params);
	// run-test.sh moved to s2-agent-ext-devops/scripts/ (it cds itself to
	// the s2-agent package dir via PI_AGENT_DIR). Invoke as `bash <abs path>`
	// rather than a `./run-test.sh` relative cmd: a relative cmd only resolves
	// against cwd (POSIX exec semantics) and needs the exec bit set — bash with
	// an absolute path works from any cwd on every POSIX checkout.
	const scriptsDir = resolve(piAgentDir, "..", "s2-agent-ext-devops", "scripts");
	const res = await run({
		cmd: "bash",
		args: [resolve(scriptsDir, "run-test.sh"), ...argv],
		cwd: scriptsDir,
		timeoutMs: TIER_TIMEOUT_MS[tier],
		logName: `pi-verify-${tier}`,
	});
	const steps = parseVerifyOutput(res.output);
	const ok = res.exitCode === 0 && !res.timedOut;
	return {
		ok,
		tier,
		steps,
		exitCode: res.exitCode,
		logPath: res.logPath,
		errorTail: ok ? undefined : (res.timedOut ? `${tier} exceeded timeout` : tailOutput(res.output)),
	};
}
