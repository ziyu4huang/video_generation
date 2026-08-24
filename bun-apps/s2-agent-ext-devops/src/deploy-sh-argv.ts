/**
 * deploy-sh-argv.ts — pure argv parsing for deploy-cli.
 *
 * Kept separate from the CLI (same split as deploy-argv.ts / deploy-tool.ts) so
 * the flag contract is unit-testable without running a deploy.
 *
 * There is no --ext: version dirs are immutable (Phase 3 §b deleted the
 * in-place rebuild); an extension-only change is an ordinary deploy, which the
 * core cache makes compile-free.
 *
 * There is no --config either (registry-code-as-config t03): the registry is
 * bun-apps/s2-agent/src/registry-config.ts, read by import — a config-file
 * override would point at the retired YAML. The flag errors loudly instead of
 * being silently ignored.
 */
import type { DeployShOptions } from "../src/deploy/run.ts";

export type DeployShAction =
	| { kind: "deploy"; options: DeployShOptions }
	| { kind: "list"; outRoot?: string }
	| { kind: "help" };

export type ParseArgvResult = { ok: true; action: DeployShAction } | { ok: false; error: string };

const VALUE_FLAGS = new Set(["--out", "--version"]);
const BOOL_FLAGS = new Set(["--no-freeze", "--no-current", "--force", "--list", "--help", "--json"]);

export function parseDeployShArgv(argv: string[]): ParseArgvResult {
	const options: DeployShOptions = {};
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

		if (flag === "--config") {
			return {
				ok: false,
				error: "--config is retired: the registry is bun-apps/s2-agent/src/registry-config.ts (registry-code-as-config t03)",
			};
		}

		if (VALUE_FLAGS.has(flag)) {
			if (value === undefined) {
				value = argv[++i];
				if (value === undefined || value.startsWith("--")) {
					return { ok: false, error: `flag ${flag} requires a value` };
				}
			}
			if (flag === "--out") options.outRoot = value;
			else options.version = value;
			// --out is meaningful for both actions; the rest are deploy-only.
			if (flag !== "--out") sawDeployFlag = true;
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
		return { ok: true, action: { kind: "list", outRoot: options.outRoot } };
	}
	return { ok: true, action: { kind: "deploy", options } };
}
