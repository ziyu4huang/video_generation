/**
 * Unit tests for the change-triggered deploy-e2e decision — the pure half of
 * run_local_ci's PI_AGENT_E2E gate. Pattern list + predicate, no fs/git: the
 * recipe feeds it `git diff --name-only` output (see ci-recipe tests).
 */
import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
		// repo-relative diff lines look like "bun-apps/s2-agent/run.sh"
		expect(shouldRunDeployE2e(["bun-apps/s2-agent/run.sh"])).toBe(true);
		expect(shouldRunDeployE2e(["bun-apps/s2-agent/src/patches/index.ts"])).toBe(true);
		expect(shouldRunDeployE2e(["bun-apps/s2-agent-ext-devops/scripts/deploy.ts"])).toBe(true);
		expect(shouldRunDeployE2e(["bun-apps/s2-agent-ext-devops/src/deploy/run.ts"])).toBe(true);
		expect(shouldRunDeployE2e(["s2-agent.sh"])).toBe(true);
	});
	test("no false positives from similar names", () => {
		expect(shouldRunDeployE2e(["bun-apps/s2-agent/src/cli/sessions/shared.ts"])).toBe(false);
		expect(shouldRunDeployE2e(["docs/s2-agent.sh.md"])).toBe(false);
		expect(shouldRunDeployE2e(["bun-apps/s2-agent-ext-ultracode/src/index.ts"])).toBe(false);
	});
	test("command constant pins the gated files", () => {
		expect(DEPLOY_E2E_COMMAND).toBe("PI_AGENT_E2E=1 bun test src/__tests__/e2e-launcher.test.ts");
		expect(DEPLOY_E2E_COMMAND).not.toContain("PI_AGENT_E2E_DEPLOY");
	});

	// The string pin above is not enough on its own, and that is not a
	// hypothetical: the command named e2e-patches + e2e-extensions long enough
	// for both files to be DELETED, and this suite stayed green while local_ci
	// failed with "filters did not match any test files". Compare the pin to the
	// filesystem, not only to itself.
	test("every test file the command names actually exists", () => {
		const piAgent = join(import.meta.dir, "..", "..", "s2-agent");
		const files = DEPLOY_E2E_COMMAND.split(/\s+/).filter((t) => t.endsWith(".test.ts"));
		expect(files.length, `no .test.ts file parsed out of "${DEPLOY_E2E_COMMAND}"`).toBeGreaterThan(0);
		const missing = files.filter((f) => !existsSync(join(piAgent, f)));
		expect(
			missing,
			`the gate would run \`bun test\` against missing file(s): ${missing.join(", ")} — ` +
				"bun exits 1 with \"filters did not match any test files\", so local_ci goes red " +
				"with a message that reads like a bun bug rather than a stale command.",
		).toEqual([]);
	});
});
