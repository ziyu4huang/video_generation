/**
 * Unit tests for the change-triggered deploy-e2e decision — the pure half of
 * local_ci's PI_AGENT_E2E gate. Pattern list + predicate, no fs/git: the
 * recipe feeds it `git diff --name-only` output (see ci-recipe tests).
 */
import { test, expect, describe } from "bun:test";
import {
	DEPLOY_E2E_COMMAND,
	DEPLOY_SENSITIVE_PATTERNS,
	shouldRunDeployE2e,
} from "../src/ci-deploy-gate.js";

describe("shouldRunDeployE2e", () => {
	test("empty change set → no trigger", () => {
		expect(shouldRunDeployE2e([])).toBe(false);
	});
	test("unrelated files → no trigger", () => {
		expect(
			shouldRunDeployE2e([
				"bun-apps/gui-movie-director/src/App.tsx",
				"python/mlx-movie-director/app/run.py",
				"README.md",
			]),
		).toBe(false);
	});
	test("every sensitive pattern triggers", () => {
		for (const p of DEPLOY_SENSITIVE_PATTERNS) {
			expect(shouldRunDeployE2e([`some/other/file.ts`, `${p}x`])).toBe(true);
		}
	});
	test("patterns match at any depth position (prefix-substring)", () => {
		// repo-relative diff lines look like "bun-apps/pi-agent/run.sh"
		expect(shouldRunDeployE2e(["bun-apps/pi-agent/run.sh"])).toBe(true);
		expect(shouldRunDeployE2e(["bun-apps/pi-agent/src/patches/index.ts"])).toBe(true);
		expect(shouldRunDeployE2e(["bun-apps/pi-agent-ext-devops/scripts/deploy-sh.ts"])).toBe(true);
		expect(shouldRunDeployE2e(["pi-agent.sh"])).toBe(true);
	});
	test("no false positives from similar names", () => {
		expect(shouldRunDeployE2e(["bun-apps/pi-agent/src/cli/sessions/shared.ts"])).toBe(false);
		expect(shouldRunDeployE2e(["docs/pi-agent.sh.md"])).toBe(false);
		expect(shouldRunDeployE2e(["bun-apps/pi-agent-ext-workflow/src/index.ts"])).toBe(false);
	});
	test("command constant pins the gated files (no DEPLOY matrix)", () => {
		expect(DEPLOY_E2E_COMMAND).toBe(
			"PI_AGENT_E2E=1 bun test src/__tests__/e2e-patches.test.ts src/__tests__/e2e-extensions.test.ts",
		);
		expect(DEPLOY_E2E_COMMAND).not.toContain("PI_AGENT_E2E_DEPLOY");
	});
});
