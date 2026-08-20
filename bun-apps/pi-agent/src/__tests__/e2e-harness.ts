/**
 * e2e-harness — shared path constants and the E2E opt-in gate for pi-agent's
 * remaining end-to-end tests.
 *
 * It used to build a bundle deploy and spawn it (ensureBundle / runBundle /
 * DEPLOY_SCRIPT / DIST_BUNDLE). That machinery went with the four legacy deploy
 * modes: the deployed artifact is now the versioned sh tree, and its e2e lives
 * in pi-agent-ext-devops/tests/deploy-sh-probe-e2e.test.ts, which calls
 * runShDeploy directly rather than through a shared build cache.
 *
 * `bun-apps/pi-agent-ext-devops/scripts/run-test.sh` sets PI_AGENT_E2E=1 for
 * the tiers that run these.
 */
import { dirname, join } from "node:path";

/** bun-apps/pi-agent (this package). import.meta.dir = <pkg>/src/__tests__ */
export const PI_AGENT_DIR = dirname(dirname(import.meta.dir));
/** repo root. */
export const REPO_ROOT = dirname(dirname(PI_AGENT_DIR));
/** Source-mode entry — what `bun src/cli.ts` runs. */
export const SRC_CLI = join(PI_AGENT_DIR, "src", "cli.ts");

const truthy = (v: string | undefined) => v === "1" || v === "true" || v === "yes";

/** E2E fires only when PI_AGENT_E2E is set; otherwise test files skip themselves. */
export const E2E_ENABLED = truthy(process.env.PI_AGENT_E2E);
