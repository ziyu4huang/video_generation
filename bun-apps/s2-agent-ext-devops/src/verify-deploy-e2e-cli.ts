#!/usr/bin/env bun
/**
 * verify-deploy-e2e-cli — bash-callable entry point for `runDeployE2e`.
 *
 * `bun bun-apps/s2-agent-ext-devops/src/verify-deploy-e2e-cli.ts`
 *
 * Runs the three bounded probes (boot / ext-load / model-call) against the
 * version dir a deploy root's `current` points at, and prints the structured
 * outcome as JSON on stdout. Read-only for the repo; the probes spawn the
 * DEPLOYED s2-agent.sh launcher only. This is the post-deploy step the devops chain was
 * missing: the deploy gates verify the staged tree, nothing re-verified the
 * final frozen `current` — and the deeper E2E suites are PI_AGENT_E2E-gated,
 * so they never run in CI.
 *
 * Exit 0 pass or skip (provider-down is a SKIP, not a FAIL — the boot is what
 * we vouch for) · 1 fail (boot/ext-load/model-call, or no `current`) · 2 usage.
 */
import { resolve } from "node:path";
import { shConfig } from "./deploy/lib/config.ts";
import { runDeployE2e, resolveCurrentVersionDir, resolveModelEndpoint } from "./deploy-e2e-recipe.js";
import { createLiveSpawn, type SpawnFn } from "./spawn.js";
import { type CliResult, emit, helpRequested, jsonResult, usageError } from "./cli-common.js";

export const VERIFY_DEPLOY_E2E_CLI_USAGE = [
	"usage: verify-deploy-e2e-cli.ts [--deploy-root <path>] [--skip-model-call]",
	"",
	"Proves the DEPLOYED dist actually works: boots s2-agent.sh (the launcher),",
	"checks every deploy.json-enabled extension",
	"reports loaded, and places a real one-shot model call through the deployed",
	"launcher. Bounded (60s/60s/300s caps — the",
	"model call gets multi-model-contention headroom); a fast provider/auth",
	"failure is a SKIP, never a FAIL. Before the model call, the endpoint's",
	"/v1/models is checked: >1 large resident chat model emits a `warnings` note",
	"",
	"Default deploy root: outRoot from bun-apps/s2-agent/src/registry-config.ts",
	"(the same value deploy-cli deploys into). `current` must exist and point at",
	"a version dir.",
	"",
	"NOTE: never probe interactive subcommands (e.g. bare `auth`) — the upstream",
	"TUI blocks forever without a TTY.",
	"",
	"Exit 0 pass/skip · 1 fail · 2 usage error.",
	"Options:",
	"  --deploy-root <path>   default: the registry's outRoot",
	"  --skip-model-call      boot + ext-load only (offline / provider-less boxes)",
].join("\n");

export interface ParsedVerifyDeployE2eArgs {
	deployRoot?: string;
	skipModelCall?: boolean;
}

/** Pure argv → flags (or a usage-error message). Exported for tests. */
export function parseVerifyDeployE2eArgs(
	argv: string[],
): { ok: true; args: ParsedVerifyDeployE2eArgs } | { ok: false; message: string } {
	let deployRoot: string | undefined;
	let skipModelCall: boolean | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--deploy-root") {
			const v = argv[++i];
			if (v === undefined) return { ok: false, message: "--deploy-root needs a value" };
			deployRoot = v;
		} else if (a === "--skip-model-call") {
			skipModelCall = true;
		} else if (a === "-h" || a === "--help") {
			return { ok: false, message: "" };
		} else if (a.startsWith("-")) {
			return { ok: false, message: `unknown flag: ${a}` };
		} else {
			return { ok: false, message: `unexpected positional argument: ${a}` };
		}
	}
	return { ok: true, args: { deployRoot, skipModelCall } };
}

/** Registry outRoot — the same default deploy-cli deploys into. */
function defaultDeployRoot(): string {
	const bunAppsDir = resolve(import.meta.dir, "..", "..");
	return shConfig({ bunAppsDir }).outRoot;
}

export async function runVerifyDeployE2eCli(
	argv: string[],
	deps: { spawn?: SpawnFn; deployRoot?: string; versionDir?: string; modelEndpoint?: string | null } = {},
): Promise<CliResult> {
	const parsed = parseVerifyDeployE2eArgs(argv);
	if (!parsed.ok) {
		if (helpRequested(argv)) return { exitCode: 0, stdout: "", stderr: VERIFY_DEPLOY_E2E_CLI_USAGE };
		return usageError(parsed.message, VERIFY_DEPLOY_E2E_CLI_USAGE);
	}
	const deployRoot = parsed.args.deployRoot ?? deps.deployRoot ?? defaultDeployRoot();
	const versionDir = deps.versionDir ?? resolveCurrentVersionDir(deployRoot);
	if (!versionDir) {
		return jsonResult(1, {
			verdict: "fail",
			deployRoot,
			note: `fail (no 'current' under ${deployRoot} — nothing deployed, or the symlink is broken)`,
		});
	}
	const spawn = deps.spawn ?? createLiveSpawn(versionDir);
	const outcome = await runDeployE2e({
		versionDir,
		spawn,
		skipModelCall: parsed.args.skipModelCall,
		// deps.modelEndpoint === null keeps unit tests hermetic (no fetch).
		modelEndpoint: deps.modelEndpoint === undefined ? resolveModelEndpoint() : deps.modelEndpoint,
	});
	return jsonResult(outcome.verdict === "fail" ? 1 : 0, { deployRoot, ...outcome });
}

if (import.meta.main) emit(await runVerifyDeployE2eCli(Bun.argv.slice(2)));
