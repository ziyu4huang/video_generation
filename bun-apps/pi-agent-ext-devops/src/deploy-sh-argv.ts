/**
 * deploy-sh-argv.ts — pure argv parsing for deploy-sh-cli.
 *
 * Kept separate from the CLI (same split as deploy-argv.ts / deploy-tool.ts) so
 * the flag contract is unit-testable without running a deploy.
 */
import type { DeployShOptions } from "../scripts/deploy-sh.ts";

export type DeployShAction =
	| { kind: "deploy"; options: DeployShOptions }
	| { kind: "list"; outRoot?: string; configPath?: string }
	| { kind: "help" };

export type ParseArgvResult = { ok: true; action: DeployShAction } | { ok: false; error: string };

const VALUE_FLAGS = new Set(["--config", "--out", "--version", "--ext"]);
const BOOL_FLAGS = new Set(["--no-freeze", "--no-current", "--force", "--list", "--help", "--json"]);

export function parseDeployShArgv(argv: string[]): ParseArgvResult {
	const options: DeployShOptions = {};
	const onlyExt: string[] = [];
	let list = false;
	let help = false;
	let sawDeployFlag = false;

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i]!;
		if (!token.startsWith("--")) {
			return { ok: false, error: `unexpected argument "${token}" (this CLI takes flags only)` };
		}

		const eq = token.indexOf("=");
		const flag = eq === -1 ? token : token.slice(0, eq);
		let value: string | undefined = eq === -1 ? undefined : token.slice(eq + 1);

		if (VALUE_FLAGS.has(flag)) {
			if (value === undefined) {
				value = argv[++i];
				if (value === undefined || value.startsWith("--")) {
					return { ok: false, error: `flag ${flag} requires a value` };
				}
			}
			if (flag === "--config") options.configPath = value;
			else if (flag === "--out") options.outRoot = value;
			else if (flag === "--version") options.version = value;
			else onlyExt.push(value);
			// --config/--out are meaningful for both actions; the rest are deploy-only.
			if (flag !== "--config" && flag !== "--out") sawDeployFlag = true;
			continue;
		}

		if (!BOOL_FLAGS.has(flag)) {
			return { ok: false, error: `unknown flag "${flag}" (known: ${[...VALUE_FLAGS, ...BOOL_FLAGS].join(", ")})` };
		}
		if (value !== undefined) return { ok: false, error: `flag ${flag} takes no value` };
		if (flag === "--list") list = true;
		else if (flag === "--help") help = true;
		else if (flag === "--json") continue; // JSON is always on; accepted for symmetry
		else {
			sawDeployFlag = true;
			if (flag === "--no-freeze") options.freeze = false;
			if (flag === "--no-current") options.current = false;
			if (flag === "--force") options.force = true;
		}
	}

	if (help) return { ok: true, action: { kind: "help" } };
	if (list) {
		if (sawDeployFlag) return { ok: false, error: `--list cannot be combined with deploy flags` };
		return { ok: true, action: { kind: "list", outRoot: options.outRoot, configPath: options.configPath } };
	}
	if (onlyExt.length > 0) options.onlyExt = onlyExt;
	return { ok: true, action: { kind: "deploy", options } };
}
