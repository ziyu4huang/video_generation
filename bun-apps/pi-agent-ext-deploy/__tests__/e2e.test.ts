import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDeploy } from "../src/deploy-tool.ts";
import { runVerify } from "../src/verify-tool.ts";

const E2E = process.env.PI_AGENT_E2E === "1";
const describeMaybe = E2E ? describe : describe.skip;

// Tracked so afterAll can clean it up (deploy used noFreeze, so the tree is writable).
const tempDirs: string[] = [];
afterAll(() => {
	for (const d of tempDirs) {
		try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
	}
});

describeMaybe("pi-agent-ext-deploy real e2e (PI_AGENT_E2E=1)", () => {
	test("pi_deploy bundle into a temp outDir succeeds with all ext bundles built", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "deploy-ext-e2e-"));
		tempDirs.push(outDir);
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
