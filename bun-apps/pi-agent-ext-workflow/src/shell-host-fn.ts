/**
 * shell.run host-fn — execute shell commands from workflow scripts.
 *
 * Registered as "shell.run" in the session host-fn registry. Called via
 * `call("shell.run", { cmd: ["bun", "..."] })`. Deterministic, zero-token.
 *
 * Returns: { exitCode: number, stdout: string, stderr: string }
 * Caps stdout/stderr at 20k chars each to keep journaling bounded.
 */

import type { HostFnRegistrationPayload } from "./host-fn-registry.js";

const MAX_OUTPUT = 20000;

function truncate(str: string, max: number): string {
	return str.length > max ? str.slice(0, max) + `\n[...truncated, was ${str.length} chars]` : str;
}

/**
 * Execute a command synchronously (runs in host context where Bun is available).
 */
function execute(cmd: string[]) {
	if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((c) => typeof c !== "string")) {
		throw new TypeError("cmd must be a non-empty array of strings");
	}

	const proc = Bun.spawnSync(cmd);
	const stdout = proc.stdout?.toString() ?? "";
	const stderr = proc.stderr?.toString() ?? "";

	return {
		exitCode: proc.exitCode ?? -1,
		stdout: truncate(stdout, MAX_OUTPUT),
		stderr: truncate(stderr, MAX_OUTPUT),
	};
}

/**
 * Registration payload for the shell.run host-fn. Extensions emit this
 * shape over the workflow:hostfn:v1:register event bus; the runtime applies
 * it via applyHostFnRegistration().
 */
export const shellRunHostFn: HostFnRegistrationPayload = {
	ns: "shell",
	name: "run",
	fn: (args: unknown) => {
		if (!args || typeof args !== "object") {
			throw new TypeError("shell.run requires args object with cmd array");
		}
		const { cmd } = args as { cmd?: unknown };
		return execute(cmd as string[]);
	},
	timeoutMs: 30000, // 30s default timeout for shell commands
};
