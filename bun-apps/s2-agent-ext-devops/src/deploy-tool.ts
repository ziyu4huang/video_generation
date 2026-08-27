/**
 * deploy-tool.ts — deploy_pi_agent_sh: spawn the deploy CLI and shape its
 * JSON result for the tool surface.
 *
 * The deploy pipeline (src/deploy/run.ts) is deliberately NOT imported here.
 * This file is on the shipped extension's import chain, and the pipeline's
 * module-scope import.meta resolutions would be folded by the bundler into
 * build-machine paths — exactly what the deploy relocatability gate rejects.
 * Spawning deploy-cli.ts keeps a single source of truth (the CLI IS the
 * pipeline) and keeps the shipped bundle free of deploy-pipeline code.
 * Symmetric with verify_pi_agent_deploy, which already spawns
 * scripts/run-test.ts the same way. The CLI runs the post-deploy E2E itself,
 * so the result's `e2e` field arrives pre-computed.
 */
import { dirname, resolve } from "node:path";
import { resolvePiAgentDir, runScript, tailOutput } from "./deploy-run.ts";
import type { DeployE2eOutcome } from "./deploy-e2e-recipe.js";

export interface DeployParams {
	/** Replace an existing version dir. */
	force?: boolean;
	/** Skip chmod a-w on the deployed tree (also bypasses the core cache). */
	noFreeze?: boolean;
	/** Do not repoint <outRoot>/current. */
	noCurrent?: boolean;
	/**
	 * Cross-OS target (crossos t05, D6): `<platform>-<arch>` the tree is packed
	 * for (e.g. win32-x64). Default: the build host.
	 */
	target?: string;
}

export interface DeployResult {
	ok: boolean;
	version?: string;
	target?: string;
	extensions?: Array<{ name: string; bytes: number }>;
	coreBytes?: number;
	/** True when the core came from the content-addressed cache (no recompile). */
	coreCached?: boolean;
	/** True when nothing was deployed: the version dir already exists (re-deploy). */
	noop?: boolean;
	/** Human note for a noop result (e.g. the --force hint). */
	message?: string;
	currentUpdated?: boolean;
	/** Version dirs removed by keep:N retention, oldest first. */
	pruned?: string[];
	/**
	 * Post-deploy E2E against the FINAL tree (boot + ext-load + model call;
	 * provider-down = SKIP). The six build gates verify the staged tree — this
	 * is what proves the deployed dist actually works. Run by deploy-cli.ts;
	 * present whenever the deploy (or noop) succeeded and `target` exists.
	 */
	e2e?: DeployE2eOutcome;
	errorTail?: string;
}

export interface DeployRunDeps {
	/**
	 * Spawn+parse seam over the deploy CLI. Default: the real subprocess —
	 * tests inject a fake; a real deploy (build + gates + E2E model probe)
	 * must never run in unit tests.
	 */
	run?: (params: DeployParams) => Promise<DeployResult>;
}

/** Injectable seams of deployViaCli (same testing role as DeployRunDeps.run,
 *  but granular: resolver + spawn separately). */
export interface DeploySpawnDeps {
	resolveDir?: () => string | null;
	spawn?: typeof runScript;
}

/** Build gates + ext builds + the E2E probes (the model call alone is capped
 *  at 300s) — 20 min covers a cold core cache. */
const DEPLOY_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Run the sh deploy for the given params. Failures are { ok:false } — never a
 * throw, so the tool's execute() reports them as content rather than as a
 * harness error.
 */
export async function runDeploy(params: DeployParams, deps: DeployRunDeps = {}): Promise<DeployResult> {
	return (deps.run ?? ((p) => deployViaCli(p)))(params);
}

export async function deployViaCli(
	params: DeployParams,
	deps: DeploySpawnDeps = {},
): Promise<DeployResult> {
	const resolveDir = deps.resolveDir ?? resolvePiAgentDir;
	const spawnFn = deps.spawn ?? runScript;
	const piAgentDir = resolveDir();
	if (!piAgentDir) {
		// Same fail-closed shape as verify_pi_agent_deploy: the deploy pipeline
		// exists only in the source repo, never in a deployed tree.
		return {
			ok: false,
			errorTail:
				"Could not locate the source s2-agent dir (s2-agent-ext-devops/src/deploy/run.ts not found). " +
				"deploy_pi_agent_sh is a source-repo tool — run s2-agent from the repo, or set PI_AGENT_DIR=<repo>/bun-apps/s2-agent.",
		};
	}
	const cli = resolve(piAgentDir, "..", "s2-agent-ext-devops", "src", "deploy-cli.ts");
	const args = [cli];
	if (params.target) args.push("--target", params.target);
	if (params.force) args.push("--force");
	if (params.noFreeze) args.push("--no-freeze");
	if (params.noCurrent) args.push("--no-current");
	const res = await spawnFn({
		cmd: "bun",
		args,
		cwd: dirname(cli),
		timeoutMs: DEPLOY_TIMEOUT_MS,
		logName: "deploy-pi-agent-sh",
	});
	if (res.timedOut) {
		return {
			ok: false,
			errorTail: `deploy-cli timed out after ${DEPLOY_TIMEOUT_MS / 60000} min. Full log: ${res.logPath}\n${tailOutput(res.output)}`,
		};
	}
	const parsed = parseCliJson(res.output);
	if (!parsed) {
		return {
			ok: false,
			errorTail: `deploy-cli produced no parseable result (exit ${res.exitCode}). Full log: ${res.logPath}\n${tailOutput(res.output)}`,
		};
	}
	const result = shapeCliJson(parsed);
	if (res.exitCode !== 0 && result.errorTail === undefined) {
		result.errorTail = `deploy-cli exited ${res.exitCode}. Full log: ${res.logPath}`;
	}
	return result;
}

/**
 * Extract the deploy CLI's result object from runScript's combined
 * stdout+stderr output: the CLI prints one pretty-printed JSON object to
 * stdout and human text to stderr, both teed into one string. Scans for the
 * LAST balanced top-level `{...}` block that JSON-parses into an object with
 * a boolean `ok` — brace counting skips braces inside string literals, so an
 * error message containing `{` cannot truncate the block.
 */
export function parseCliJson(output: string): Record<string, unknown> | null {
	const lines = output.split("\n");
	let best: Record<string, unknown> | null = null;
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].trimStart().startsWith("{")) continue;
		const end = scanBalanced(lines, i);
		if (end === null) continue;
		try {
			const v = JSON.parse(lines.slice(i, end + 1).join("\n")) as unknown;
			if (typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).ok === "boolean") {
				best = v as Record<string, unknown>;
			}
		} catch {
			// Not JSON — keep scanning; later `{` lines may open the real block.
		}
	}
	return best;
}

/** Line index closing the top-level object opened at `start`, or null. */
function scanBalanced(lines: string[], start: number): number | null {
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let j = start; j < lines.length; j++) {
		for (const ch of lines[j]) {
			if (inStr) {
				if (esc) esc = false;
				else if (ch === "\\") esc = true;
				else if (ch === '"') inStr = false;
			} else if (ch === '"') inStr = true;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) return j;
			}
		}
	}
	return null;
}

/**
 * The CLI's `{ ok, ...result, e2e }` object already matches DeployResult
 * except on failure, where it carries `error` instead of `errorTail` — map
 * that one key, keep the rest verbatim.
 */
function shapeCliJson(parsed: Record<string, unknown>): DeployResult {
	const { error, ...rest } = parsed;
	const result = rest as unknown as DeployResult;
	result.ok = result.ok === true;
	if (typeof error === "string") result.errorTail = error;
	return result;
}
