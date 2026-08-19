#!/usr/bin/env bun
/**
 * deploy-sh-cli.ts — CLI for the pi-agent-sh deploy.
 *
 * Convention (shared with the other devops CLIs): stdout is PURE JSON, human
 * text goes to stderr, exit 0 = ok / 1 = failure / 2 = usage error.
 *
 *   bun src/deploy-sh-cli.ts                     # full deploy
 *   bun src/deploy-sh-cli.ts --ext power-tool    # rebuild one extension in place
 *   bun src/deploy-sh-cli.ts --list              # deployed versions + current
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseDeployShArgv } from "./deploy-sh-argv.ts";
import { runShDeploy } from "../scripts/deploy-sh.ts";
import { parseShConfig } from "../scripts/lib/sh-config.ts";
import { listVersions } from "../scripts/lib/sh-version.ts";

const BUN_APPS_DIR = resolve(import.meta.dir, "..", "..");
const DEFAULT_CONFIG = join(BUN_APPS_DIR, "pi-agent", "deploy-config.yaml");

const HELP = `deploy-sh-cli — versioned minimal-core deploy for pi-agent

USAGE
  bun src/deploy-sh-cli.ts [flags]

FLAGS
  --config <path>   deploy config (default: bun-apps/pi-agent/deploy-config.yaml)
  --out <dir>       override outRoot from the config
  --version <str>   override the computed <pkgVersion>+g<sha> version
  --ext <name>      rebuild ONLY this extension into the existing version dir
                    (repeatable; fails if that version dir does not exist)
  --force           replace an existing version dir
  --no-freeze       skip chmod a-w on the deployed tree
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
	console.log(JSON.stringify({ ok: true, ...result }, null, 2));
	process.exit(0);
} catch (e) {
	const message = e instanceof Error ? e.message : String(e);
	console.log(JSON.stringify({ ok: false, error: message }, null, 2));
	console.error(`✗ ${message}`);
	process.exit(1);
}
