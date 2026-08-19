/**
 * ci-deploy-gate — the pure decision behind local_ci's change-triggered
 * deploy-e2e gate.
 *
 * WHY THIS GATE EXISTS: the workflow-derived gate suite already boots all
 * deploy modes on every run (check-deploy-artifacts.sh / check-deploy-sh-e2e.sh
 * via `regression-gates`), but the PI_AGENT_E2E-gated bundle-mode assertions —
 * e2e-patches (every PATCH_TABLE entry reports applied in the built bundle)
 * and e2e-extensions' SOURCE blocks (doctor --smoke, >4 KB module load, lazy
 * `-e` splice) — never ran under local_ci. Those are the tiers that catch the
 * #1305 class (harness literal drift that only fails at the gated tiers), so
 * they run ONLY when the change set touches the deploy-sensitive paths below.
 * One `bun test` process covers both files → the harness's existing
 * per-process ensureBundle() cache means a single bundle build (~15s).
 */
import type { SpawnFn } from "./spawn.js";

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
	"bun-apps/pi-agent/package.json", // deploy:* scripts live here
	"bun-apps/pi-agent/src/cli.ts", // the bundled entry
	"bun-apps/pi-agent/src/patches/",
	"bun-apps/pi-agent/src/static-extensions.ts",
	"bun-apps/pi-agent/run-dir/manifest.json",
	"bun-apps/pi-agent/scripts/",
];

/** What the gate runs, from bun-apps/pi-agent. PI_AGENT_E2E only — the
 *  4-cwd DEPLOY matrix needs PI_AGENT_E2E_DEPLOY and stays a manual tier. */
export const DEPLOY_E2E_COMMAND =
	"PI_AGENT_E2E=1 bun test src/__tests__/e2e-patches.test.ts src/__tests__/e2e-extensions.test.ts";

/** The gate's display name in the CiOutcome.gates list (consumed by ci-recipe). */
export const DEPLOY_E2E_GATE_NAME =
	"Deploy e2e — PI_AGENT_E2E bundle assertions (change-triggered)";

/** True when any changed file is deploy-sensitive. */
export function shouldRunDeployE2e(changedFiles: string[]): boolean {
	return changedFiles.some((f) => !f.endsWith(".md") && DEPLOY_SENSITIVE_PATTERNS.some((p) => f.includes(p)));
}
