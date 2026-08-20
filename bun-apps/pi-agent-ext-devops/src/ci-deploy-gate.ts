/**
 * ci-deploy-gate — the pure decision behind run_local_ci's change-triggered
 * deploy-e2e gate.
 *
 * WHY THIS GATE EXISTS: `regression-gates` boots the deployed artifact on every
 * run (check-deploy-sh-e2e.sh), but a PI_AGENT_E2E-gated assertion is invisible
 * to a plain `bun test` and therefore invisible to local_ci's package matrix.
 * A test nobody runs is the same as no test — the #1305 class, where a literal
 * drifted and only failed at a tier nothing executed.
 *
 * WHAT IT COVERS NOW: e2e-launcher's `symlink resolution` block, which spawns
 * the REAL src/cli.ts through run.sh and is the only remaining PI_AGENT_E2E-
 * gated assertion in the repo. It is gated because a full pi boot touches the
 * shared ~/.pi backend, not because it is slow — so it runs ONLY when the
 * change set touches the launcher/entry chain listed below.
 *
 * It used to run e2e-patches + e2e-extensions, whose subject was the bundle
 * deploy. Both files went with the four legacy deploy modes; the deployed
 * artifact's own e2e is check-deploy-sh-e2e.sh, which is unconditional.
 */

/**
 * Repo-relative path fragments that make a change deploy-sensitive. A diff
 * line triggers if it CONTAINS any fragment. Deliberately narrow: touching
 * all of bun-apps/pi-agent/src/** would fire on every pi-agent PR, when the
 * gated assertions only exercise the loader/patch/entry chain listed here.
 */
export const DEPLOY_SENSITIVE_PATTERNS: readonly string[] = [
	"bun-apps/pi-agent-ext-devops/scripts/",
	"bun-apps/pi-agent/run.sh",
	"pi-agent.sh", // repo-root symlink to bun-apps/pi-agent/run.sh
	"bun-apps/pi-agent/package.json", // update-pi.sh + deploy:sh are declared here
	"bun-apps/pi-agent/src/cli.ts", // the source entry the launcher spawns
	"bun-apps/pi-agent/src/patches/",
	"bun-apps/pi-agent/src/static-extensions.ts",
	"bun-apps/pi-agent/run-dir/manifest.json",
	"bun-apps/pi-agent/scripts/",
];

/** What the gate runs, from bun-apps/pi-agent. */
export const DEPLOY_E2E_COMMAND =
	"PI_AGENT_E2E=1 bun test src/__tests__/e2e-launcher.test.ts";

/** The gate's display name in the CiOutcome.gates list (consumed by ci-recipe). */
export const DEPLOY_E2E_GATE_NAME =
	"Launcher e2e — PI_AGENT_E2E gated assertions (change-triggered)";

/** True when any changed file is deploy-sensitive. */
export function shouldRunDeployE2e(changedFiles: string[]): boolean {
	return changedFiles.some((f) => !f.endsWith(".md") && DEPLOY_SENSITIVE_PATTERNS.some((p) => f.includes(p)));
}
