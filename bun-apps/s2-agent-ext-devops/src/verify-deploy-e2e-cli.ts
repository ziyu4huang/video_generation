#!/usr/bin/env bun
/**
 * verify-deploy-e2e-cli — bash-callable entry point for `runDeployE2e`.
 *
 * `bun bun-apps/s2-agent-ext-devops/src/verify-deploy-e2e-cli.ts`
 *
 * Runs the bounded probes (boot / ext-load / tools-probe / model-call /
 * vision-call / file2md-ocr / tool-gate-fire — the latter three skip when not
 * applicable to the deploy set) against the version dir a deploy root's
 * `current` points at, and prints the structured
 * outcome as JSON on stdout. Read-only for the repo; the probes spawn the
 * DEPLOYED s2-agent.sh launcher only. This is the post-deploy step the devops chain was
 * missing: the deploy gates verify the staged tree, nothing re-verified the
 * final frozen `current` — and the deeper E2E suites are PI_AGENT_E2E-gated,
 * so they never run in CI.
 *
 * Exit 0 pass or skip (provider-down is a SKIP, not a FAIL — the boot is what
 * we vouch for) · 1 fail (any probe, or no `current`) · 2 usage.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { shConfig } from "./deploy/lib/config.ts";
import {
	runDeployE2e,
	resolveCurrentVersionDir,
	resolveModelEndpoint,
	resolveE2eModelPin,
	isNonHostTree,
} from "./deploy-e2e-recipe.js";
import { createLiveSpawn, type SpawnFn } from "./spawn.js";
import { type CliResult, emit, helpRequested, jsonResult, usageError } from "./cli-common.js";

export const VERIFY_DEPLOY_E2E_CLI_USAGE = [
	"usage: verify-deploy-e2e-cli.ts [--deploy-root <path>] [--dev-launcher <path>] [--skip-model-call]",
	"",
	"Proves the DEPLOYED dist actually works: boots the deployed launcher (the sh launcher; cmd /c s2-agent.cmd on win32 trees),",
	"checks every deploy.json-enabled extension",
	"reports loaded, and places a real one-shot model call through the deployed",
	"launcher. The providers-catalog probe additionally lists models TWICE",
	"(patch on/off, scratch agent-dir) proving the baked PROVIDERS catalog —",
	"the pre-load-providers ModelRuntime.create wrap — is alive in the final",
	"tree (the pre-0.80 loadModels death was masked by models.json duplication).",
	"Bounded (60s/60s/300s caps — the",
	"model call gets multi-model-contention headroom); a fast provider/auth",
	"failure is a SKIP, never a FAIL. The model call also carries two REGRESSION",
	"BUDGETS: one-shot wall time ≤35s (baseline p95 10.99s measured 2026-08-24;",
	"a slower completed run fails, unless the contention precheck fired → skip)",
	"and hermes-memory startup round-trips ≤150 (from the slow-startup banner;",
	"measured 103–114 dirty-vault / 26 clean). Before the model call, the endpoint's",
	"/v1/models is checked: >1 large resident chat model emits a `warnings` note.",
	"",
	"VISION-CALL probe: when file2md is in the deploy set (and --skip-model-call",
	"is absent), the deployed file2md bundle's vision_ask tool answers a question",
	"about a fixture image; the reply must contain text only knowable by SEEING",
	"the image — proving the DEFAULT vision lane (capabilities.vision) actually",
	"processes images instead of silently falling back to a text model (the",
	"#1981 follow-up; measured 2026-08-24: a broken lane answers nothing in 0.3s).",
	"",
	"Default deploy root: outRoot from bun-apps/s2-agent/src/registry-config.ts",
	"(the same value deploy-cli deploys into). `current` must exist and point at",
	"a version dir.",
	"",
	"MODEL PIN: set VERIFY_E2E_MODEL=provider/model-id (e.g. deepseek/deepseek-",
	"v4-flash-vision-exp) to pin the one-shot spawns (model-call + tools-probe)",
	"to ONE lane via PI_PROVIDER/PI_MODEL/PI_THINKING=off — the D8 form. Pinned,",
	"the 35s runtime budget is deterministic (a light lane answers well under",
	"it; a breach on a pinned light lane is the #1976 serialization class), and",
	"the local-endpoint contention precheck neither runs nor downgrades a",
	"breach. Unset: the tree's default lane, behavior unchanged (measured",
	"2026-08-29: the default LM Studio 27b lane cold-starts ~36s — a coin flip",
	"against the 35s budget).",
	"",
	"NOTE: never probe interactive subcommands (e.g. bare `auth`) — the upstream",
	"TUI blocks forever without a TTY.",
	"",
	"Exit 0 pass/skip · 1 fail · 2 usage error.",
	"Options:",
	"  --deploy-root <path>   default: the registry's outRoot",
	"  --dev-launcher <path>  dev tree's s2-agent.sh for the parity probe (default: <repo>/s2-agent.sh when present; absent → parity skips)",
	"  --skip-model-call      boot + ext-load only (offline / provider-less boxes)",
].join("\n");

export interface ParsedVerifyDeployE2eArgs {
	deployRoot?: string;
	devLauncher?: string;
	skipModelCall?: boolean;
}

/** Pure argv → flags (or a usage-error message). Exported for tests. */
export function parseVerifyDeployE2eArgs(
	argv: string[],
): { ok: true; args: ParsedVerifyDeployE2eArgs } | { ok: false; message: string } {
	let deployRoot: string | undefined;
	let devLauncher: string | undefined;
	let skipModelCall: boolean | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--deploy-root") {
			const v = argv[++i];
			if (v === undefined) return { ok: false, message: "--deploy-root needs a value" };
			deployRoot = v;
		} else if (a === "--dev-launcher") {
			const v = argv[++i];
			if (v === undefined) return { ok: false, message: "--dev-launcher needs a value" };
			devLauncher = v;
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
	return { ok: true, args: { deployRoot, devLauncher, skipModelCall } };
}

/** Registry outRoot — the same default deploy-cli deploys into. */
function defaultDeployRoot(): string {
	const bunAppsDir = resolve(import.meta.dir, "..", "..");
	return shConfig({ bunAppsDir }).outRoot;
}

/** Repo-root dev launcher — the parity probe's dev-tree baseline. The symlink
 * is tracked in git, so it exists in every checkout/worktree; when it somehow
 * doesn't (exotic exports), the default stays undefined and parity skips. */
function defaultDevLauncher(): string | undefined {
	const p = resolve(import.meta.dir, "..", "..", "..", "s2-agent.sh");
	return existsSync(p) ? p : undefined;
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
	// crossos t05: a non-host tree's launcher + bun cannot boot on this
	// machine — booting it produces a false FAIL for a healthy cross-built
	// tree. Skip with the t06 note instead (same rule as deploy-cli).
	if (isNonHostTree(versionDir)) {
		return jsonResult(0, {
			verdict: "skip",
			deployRoot,
			note: "skip (crossos t05: non-host target tree — cross-OS boot verification is t06's channel)",
		});
	}
	const spawn = deps.spawn ?? createLiveSpawn(versionDir);
	// Lane pin (shared surface with deploy-cli): VERIFY_E2E_MODEL from the
	// environment. A malformed value warns and runs unpinned — never silent.
	const pin = resolveE2eModelPin();
	const outcome = await runDeployE2e({
		versionDir,
		spawn,
		// Flag OR repo-root default — the same baseline deploy-cli's auto-E2E
		// uses; absent everywhere (e.g. a dist-only box) → parity skips.
		devLauncher: parsed.args.devLauncher ?? defaultDevLauncher(),
		// Flag OR env — one opt-out surface shared with deploy-cli's auto-E2E
		// (crossos t06): the GH Actions verify runners export the env var, and a
		// local operator mirroring that shell gets the same behavior from BOTH
		// CLIs instead of two divergent answers.
		skipModelCall: parsed.args.skipModelCall || process.env.S2_AGENT_E2E_SKIP_MODEL_CALL === "1",
		// deps.modelEndpoint === null keeps unit tests hermetic (no fetch).
		modelEndpoint: deps.modelEndpoint === undefined ? resolveModelEndpoint() : deps.modelEndpoint,
		modelPin: pin?.ok ? pin.pin : undefined,
	});
	if (pin && !pin.ok) outcome.warnings.push(pin.message);
	return jsonResult(outcome.verdict === "fail" ? 1 : 0, { deployRoot, ...outcome });
}

if (import.meta.main) emit(await runVerifyDeployE2eCli(Bun.argv.slice(2)));
