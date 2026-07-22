import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { runDeploy } from "../src/deploy-tool.ts";
import { runVerify } from "../src/verify-tool.ts";

const E2E = process.env.PI_AGENT_E2E === "1";
const describeMaybe = E2E ? describe : describe.skip;

describeMaybe("pi-agent-ext-deploy real e2e (PI_AGENT_E2E=1)", () => {
	test("pi_deploy bundle into a temp outDir succeeds with all ext bundles built", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "deploy-ext-e2e-"));
		const r = await runDeploy({ mode: "bundle", outDir, noFreeze: true });
		expect(r.ok).toBe(true);
		expect(r.exitCode).toBe(0);
		expect(r.extBundles.failed).toEqual([]);
		expect(r.extBundles.built).toBeGreaterThan(0);
		expect(existsSync(join(outDir, "pi-agent.js"))).toBe(true);
	}, 5 * 60_000);

	test("pi_verify quick tier passes", async () => {
		const r = await runVerify({ tier: "quick" });
		expect(r.ok).toBe(true);
		expect(r.exitCode).toBe(0);
	}, 60_000);
});
