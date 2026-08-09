/**
 * argv.ts — PURE param→argv mapping for the deploy/verify tools.
 *
 * Isolated from spawning so the tricky flag/positional ordering is unit-tested
 * without running a 50s deploy. deploy.ts parses argv as: one optional
 * positional (outDir) + known flags (--bundle/--snapshot/--standalone/--exe/
 * --no-freeze). run-test.sh takes the tier as its first positional + optional
 * forwarded flags (--bail).
 */

export type DeployMode = "bundle" | "snapshot" | "standalone" | "exe";

export interface DeployParams {
	mode?: DeployMode;
	outDir?: string;
	noFreeze?: boolean;
}

const DEPLOY_MODE_FLAG: Record<DeployMode, string> = {
	bundle: "--bundle",
	snapshot: "--snapshot",
	standalone: "--standalone",
	exe: "--exe",
};

/** Build the argv tail for `bun scripts/deploy.ts` (NOT including the script path). */
export function buildDeployArgv(params: DeployParams = {}): string[] {
	const argv: string[] = [];
	if (params.outDir) argv.push(params.outDir);
	argv.push(DEPLOY_MODE_FLAG[params.mode ?? "bundle"]);
	if (params.noFreeze) argv.push("--no-freeze");
	return argv;
}

export type VerifyTier = "quick" | "medium" | "high" | "readonly" | "full";

export interface VerifyParams {
	tier?: VerifyTier;
	bail?: boolean;
}

/** Build the argv tail for `./run-test.sh` (NOT including the script path). */
export function buildVerifyArgv(params: VerifyParams = {}): string[] {
	const argv: string[] = [params.tier ?? "medium"];
	if (params.bail) argv.push("--bail");
	return argv;
}
