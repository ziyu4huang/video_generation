/**
 * e2e-harness — shared path constants and the E2E opt-in gate for s2-agent's
 * remaining end-to-end tests.
 *
 * It used to build a bundle deploy and spawn it (ensureBundle / runBundle /
 * DEPLOY_SCRIPT / DIST_BUNDLE). That machinery went with the four legacy deploy
 * modes: the deployed artifact is now the versioned sh tree, and its e2e lives
 * in s2-agent-ext-devops/tests/deploy-probe-e2e.test.ts, which calls
 * runShDeploy directly rather than through a shared build cache.
 *
 * `bun-apps/s2-agent-ext-devops/scripts/run-test.ts` sets PI_AGENT_E2E=1 for
 * the tiers that run these.
 */
import { dirname } from "node:path";
import { envFlag } from "../env-flag.ts";

/** bun-apps/s2-agent (this package). import.meta.dir = <pkg>/src/__tests__ */
export const PI_AGENT_DIR = dirname(dirname(import.meta.dir));
/** repo root. */
export const REPO_ROOT = dirname(dirname(PI_AGENT_DIR));

/** E2E fires only when PI_AGENT_E2E is set; otherwise test files skip themselves.
 *  envFlag (round-2 ticket 05) — was a case-sensitive "1"|"true"|"yes" local;
 *  run-test.ts always sets the literal "1", so the widening is unobservable. */
export const E2E_ENABLED = envFlag("PI_AGENT_E2E", false);
