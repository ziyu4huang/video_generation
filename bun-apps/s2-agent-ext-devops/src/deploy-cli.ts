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
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseDeployShArgv } from "./deploy-sh-argv.ts";
import { DeployVersionExistsError, runShDeploy } from "./deploy/run.ts";
import { parseShConfig } from "./deploy/lib/config.ts";
import { listVersions } from "./deploy/lib/version.ts";
import { runDeployE2e, resolveModelEndpoint } from "./deploy-e2e-recipe.js";
import { createLiveSpawn } from "./spawn.js";

const BUN_APPS_DIR = resolve(import.meta.dir, "..", "..");
const DEFAULT_CONFIG = join(BUN_APPS_DIR, "s2-agent", "s2-agent.registry.yaml");

const HELP = `deploy-cli — versioned minimal-core deploy for s2-agent

USAGE
  bun src/deploy-cli.ts [flags]

FLAGS
  --config <path>   deploy registry (default: bun-apps/s2-agent/s2-agent.registry.yaml)
  --out <dir>       override outRoot from the config
  --version <str>   override the computed <pkgVersion>+g<sha> version
  --force           replace an existing version dir
  (re-deploying the CURRENT version without --force is a no-op success:
   { ok: true, noop: true } — same git sha means same content)
  --no-freeze       skip chmod a-w on the deployed tree (also bypasses the core cache)
  --no-current      do not repoint <outRoot>/current
  --list            list deployed versions and the current target
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
		const configPath = parsed.action.configPath ? resolve(parsed.action.configPath) : DEFAULT_CONFIG;
		const outRoot = parsed.action.outRoot
			? resolve(parsed.action.outRoot)
			: parseShConfig(readFileSync(configPath, "utf8"), { bunAppsDir: BUN_APPS_DIR }).outRoot;
		console.log(JSON.stringify({ ok: true, outRoot, ...listVersions(outRoot) }, null, 2));
		process.exit(0);
	}

	const result = await runShDeploy(parsed.action.options);
	// Post-deploy E2E (2026-08-22): the six build gates verify the STAGED
	// tree; this re-boots the FINAL (frozen, swapped) tree and places a real
	// model call through run.sh. Provider-down is a SKIP, not a failure — but
	// a boot/ext-load/model-call fail means the deploy is broken: exit 1.
	const e2e = await runDeployE2e({
		versionDir: result.target,
		spawn: createLiveSpawn(result.target),
		modelEndpoint: resolveModelEndpoint(),
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
		const e2e = await runDeployE2e({
			versionDir: e.target,
			spawn: createLiveSpawn(e.target),
			modelEndpoint: resolveModelEndpoint(),
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
