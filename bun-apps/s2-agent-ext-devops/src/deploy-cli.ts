#!/usr/bin/env bun
/**
 * deploy-cli.ts — CLI for the s2-agent-sh deploy.
 *
 * Convention (shared with the other devops CLIs): stdout is PURE JSON, human
 * text goes to stderr, exit 0 = ok / 1 = failure / 2 = usage error.
 *
 *   bun src/deploy-cli.ts                     # deploy (version dirs are immutable)
 *   bun src/deploy-cli.ts --list              # deployed versions + current
 */
import { join, resolve } from "node:path";
import { parseDeployShArgv } from "./deploy-sh-argv.ts";
import { DeployVersionExistsError, runShDeploy } from "./deploy/run.ts";
import { shConfig } from "./deploy/lib/config.ts";
import { listTargetLayout } from "./deploy/lib/version.ts";
import { runDeployE2e, resolveModelEndpoint, isNonHostTree } from "./deploy-e2e-recipe.js";
import { createLiveSpawn } from "./spawn.js";

const BUN_APPS_DIR = resolve(import.meta.dir, "..", "..");

const HELP = `deploy-cli — versioned minimal-core deploy for s2-agent

USAGE
  bun src/deploy-cli.ts [flags]

FLAGS
  --out <dir>       override outRoot from the registry
  --version <str>   override the computed <pkgVersion>+g<sha> version
  --target <name>   cross-OS target (crossos t05, D6): <platform>-<arch>
                    the tree is packed for, e.g. win32-x64, linux-x64.
                    Default: this host. Version dirs + current live under
                    <outRoot>/<target>/; the .cores/.buns caches are shared.
                    A non-host target fetches its bun from the GitHub release
                    (D7; override the base with S2_AGENT_BUN_RELEASE_BASE)
                    and skips the boot gates + post-deploy E2E (t06 owns the
                    cross-OS verification channel).
  --force           replace an existing version dir
  (re-deploying the CURRENT version without --force is a no-op success:
   { ok: true, noop: true } — same git sha means same content)
  --no-freeze       skip chmod a-w on the deployed tree (also bypasses the core cache)
  --no-current      do not repoint <outRoot>/<target>/current
  --list            list deployed versions per target subroot (+ any legacy flat layout)
  --help            this text

OUTPUT
  stdout is JSON. Exit 0 = ok, 1 = failure, 2 = usage error.
`;

const parsed = parseDeployShArgv(process.argv.slice(2));
if (!parsed.ok) {
	console.error(parsed.error);
	console.error(HELP);
	process.exit(2);
}

if (parsed.action.kind === "help") {
	console.error(HELP);
	process.exit(0);
}

try {
	if (parsed.action.kind === "list") {
		const outRoot = parsed.action.outRoot
			? resolve(parsed.action.outRoot)
			: shConfig({ bunAppsDir: BUN_APPS_DIR }).outRoot;
		console.log(JSON.stringify({ ok: true, outRoot, ...listTargetLayout(outRoot) }, null, 2));
		process.exit(0);
	}

	const result = await runShDeploy(parsed.action.options);
	// Post-deploy E2E (2026-08-22): the six build gates verify the STAGED
	// tree; this re-boots the FINAL (frozen, swapped) tree and places a real
	// model call through the deployed launcher. Provider-down (incl.
	// connection-refused — the GH Actions verify runners) is a SKIP, not a
	// failure — but
	// a boot/ext-load/model-call fail means the deploy is broken: exit 1.
	// crossos t05: a non-host target's tree cannot boot on this build host
	// (its bin/bun(.exe) is a foreign binary) — skip with a note, t06 owns
	// the cross-OS verification channel. result.runtime already carries the
	// TARGET's facts (not the host's) — no disk re-read needed here.
	const nonHost = result.runtime.platform !== process.platform || result.runtime.arch !== process.arch;
	// S2_AGENT_E2E_SKIP_MODEL_CALL=1 (crossos t06): provider-less runners in the
	// GH Actions verify channel skip the model-call probe EXPLICITLY instead of
	// relying on the fast-failure heuristic (connect-refused → skip).
	const skipModelCall = process.env.S2_AGENT_E2E_SKIP_MODEL_CALL === "1";
	const e2e = nonHost
		? { verdict: "skip", note: `crossos t05: non-host target ${result.targetName} — post-deploy E2E deferred to t06` }
		: await runDeployE2e({
				versionDir: result.target,
				spawn: createLiveSpawn(result.target),
				modelEndpoint: resolveModelEndpoint(),
				skipModelCall,
			});
	console.log(JSON.stringify({ ok: e2e.verdict !== "fail", ...result, e2e }, null, 2));
	if (e2e.verdict === "fail") {
		console.error(`✗ post-deploy E2E failed: ${e2e.note}`);
		process.exit(1);
	}
	process.exit(0);
} catch (e) {
	// Same classification as deploy-tool.ts: an existing version dir is a
	// no-op success (content-addressed by git sha), so scripts can distinguish
	// "nothing to do" from a real failure without string-matching error text.
	if (e instanceof DeployVersionExistsError) {
		const e2e = isNonHostTree(e.target)
			? { verdict: "skip", note: `crossos t05: non-host target — post-deploy E2E deferred to t06` }
			: await runDeployE2e({
					versionDir: e.target,
					spawn: createLiveSpawn(e.target),
					modelEndpoint: resolveModelEndpoint(),
					skipModelCall: process.env.S2_AGENT_E2E_SKIP_MODEL_CALL === "1",
				});
		console.log(JSON.stringify({ ok: e2e.verdict !== "fail", noop: true, version: e.version, target: e.target, message: e.message, e2e }, null, 2));
		if (e2e.verdict === "fail") {
			console.error(`✗ post-deploy E2E failed: ${e2e.note}`);
			process.exit(1);
		}
		process.exit(0);
	}
	const message = e instanceof Error ? e.message : String(e);
	console.log(JSON.stringify({ ok: false, error: message }, null, 2));
	console.error(`✗ ${message}`);
	process.exit(1);
}
