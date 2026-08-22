/**
 * deploy-tool.ts — deploy_pi_agent_sh: run the versioned sh deploy and shape its result
 * for the tool surface.
 *
 * The deploy itself is scripts/deploy.ts (single source of truth). This file
 * only maps params and shapes failures. It used to spawn scripts/deploy.ts and
 * scrape its human output with regexes for the bundle size and the ext-bundle
 * built/failed counts; runShDeploy returns a typed object, so that parser is
 * gone rather than ported.
 */
import { DeployVersionExistsError, runShDeploy, type DeployShOptions, type DeployShResult } from "../scripts/deploy.ts";
import { runDeployE2e, type DeployE2eOutcome } from "./deploy-e2e-recipe.js";
import { createLiveSpawn } from "./spawn.js";

export interface DeployParams {
	/** Replace an existing version dir. */
	force?: boolean;
	/** Skip chmod a-w on the deployed tree (also bypasses the core cache). */
	noFreeze?: boolean;
	/** Do not repoint <outRoot>/current. */
	noCurrent?: boolean;
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
	 * is what proves the deployed dist actually works. Present whenever the
	 * deploy (or noop) succeeded and `target` exists; ok flips to false if it
	 * fails.
	 */
	e2e?: DeployE2eOutcome;
	errorTail?: string;
}

export interface DeployRunDeps {
	deploy?: (opts: DeployShOptions) => Promise<DeployShResult>;
	/**
	 * Post-deploy E2E seam. Default: the real runDeployE2e with a live spawn.
	 * Tests inject a fake — the model-call probe must never run in unit tests.
	 */
	e2e?: (versionDir: string) => Promise<DeployE2eOutcome>;
}

/**
 * Run the sh deploy for the given params. Failures are { ok:false } — never a
 * throw, so the tool's execute() reports them as content rather than as a
 * harness error.
 *
 * Options the caller did not ask for are OMITTED, not passed as false:
 * runShDeploy reads `opts.freeze ?? cfg.freeze`, so an unconditional
 * `freeze: false` would silently override the config instead of deferring to it.
 */
export async function runDeploy(
	params: DeployParams,
	deps: DeployRunDeps = {},
): Promise<DeployResult> {
	const deploy = deps.deploy ?? runShDeploy;
	const options: DeployShOptions = {};
	if (params.force) options.force = true;
	if (params.noFreeze) options.freeze = false;
	if (params.noCurrent) options.current = false;

	try {
		const r = await deploy(options);
		// Post-deploy E2E (2026-08-22): the six build gates verified the STAGED
		// tree; this proves the FINAL tree works. Never throws — a fail flips ok.
		const e2e = (await runE2e(deps, r.target)) ?? undefined;
		return {
			ok: e2e ? e2e.verdict !== "fail" : true,
			version: r.version,
			target: r.target,
			extensions: r.extensions,
			coreBytes: r.coreBytes,
			coreCached: r.coreCached,
			currentUpdated: r.currentUpdated,
			pruned: r.pruned,
			e2e,
		};
	} catch (e) {
		// A re-deploy of the current version is a no-op SUCCESS, not a failure:
		// the version dirs are immutable and content-addressed by git sha, so an
		// existing target means this exact tree state is already deployed. Map it
		// here (tool surface) — deploy-cli.ts does the same for the CLI surface.
		if (e instanceof DeployVersionExistsError) {
			const e2e = (await runE2e(deps, e.target)) ?? undefined;
			return { ok: e2e ? e2e.verdict !== "fail" : true, noop: true, version: e.version, target: e.target, message: e.message, e2e };
		}
		return { ok: false, errorTail: e instanceof Error ? e.message : String(e) };
	}
}

/** Resolve + run the E2E seam; null only when the seam itself is absent. */
async function runE2e(deps: DeployRunDeps, target: string): Promise<DeployE2eOutcome | null> {
	const e2e = deps.e2e ?? ((versionDir: string) => runDeployE2e({ versionDir, spawn: createLiveSpawn(versionDir) }));
	return e2e(target);
}
