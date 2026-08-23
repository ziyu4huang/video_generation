/**
 * deploy-argv.ts — PURE param→argv mapping for the verify tool.
 *
 * Isolated from spawning so the flag/positional ordering is unit-tested without
 * running a multi-minute suite. run-test.ts takes the tier as its first
 * positional + optional forwarded flags (--bail).
 *
 * The deploy half (DeployMode / buildDeployArgv) went with the four legacy
 * deploy modes: the sh deploy is a typed call (runShDeploy), not an argv.
 */

export type VerifyTier = "quick" | "medium" | "full";

export interface VerifyParams {
	tier?: VerifyTier;
	bail?: boolean;
}

/** Build the argv tail for `run-test.ts` (NOT including the script path). */
export function buildVerifyArgv(params: VerifyParams = {}): string[] {
	const argv: string[] = [params.tier ?? "medium"];
	if (params.bail) argv.push("--bail");
	return argv;
}
