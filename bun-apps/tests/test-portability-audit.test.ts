/**
 * Regression test for scripts/test-portability-audit.sh.
 *
 * The audit is a CI gate (regression-gates job, --strict) but had ZERO tests of
 * its own — any refactor could silently disable a P-class detection. This test
 * points the audit at synthetic fixture trees via the `--root` flag and pins the
 * classification logic (GUARDED vs UNGATED, block-under-strict) for each class.
 *
 * Driven by wayfinder effort 2026-07-30-self-reflection-to-fix-these-error
 * ticket 01 (close the "audit is untested + not locally runnable" gap).
 *
 * PORTABILITY-GUARDED: this test spawns `bash` to execute the committed audit
 * script (scripts/test-portability-audit.sh). bash + a committed repo script
 * are present on every CI runner (ubuntu-latest) and dev machine, so this spawn
 * is CI-safe — it is NOT a machine-coupled host-binary probe. The marker below
 * attests this so the audit classifies the file GUARDED (not UNGATED P2).
 */
import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const AUDIT = join(REPO_ROOT, "scripts", "test-portability-audit.sh");

/** Run the audit against a synthetic bun-apps/ tree rooted at `root`. */
function runAudit(root: string, strict = true): { code: number; out: string } {
	const args = strict ? ["--root", root, "--strict"] : ["--root", root];
	const r = spawnSync("bash", [AUDIT, ...args], { encoding: "utf8" });
	return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

/** Build a temp scan-root containing bun-apps/<file> with the given source. */
function fixtureTree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "audit-"));
	mkdirSync(join(root, "bun-apps"), { recursive: true });
	for (const [name, src] of Object.entries(files)) {
		writeFileSync(join(root, "bun-apps", name), src);
	}
	return root;
}

describe("test-portability-audit.sh", () => {
	test("`--root <dir>` is honored: a bare loadModelTierConfig() P5 violation blocks under --strict", () => {
		const root = fixtureTree({
			"bad-config-loader.test.ts": [
				`import { test } from "bun:test";`,
				`import { loadModelTierConfig } from "../../src/config";`,
				``,
				`test("x", () => {`,
				`  const c = loadModelTierConfig(); // bare call — reads real ~/.pi`,
				`  expect(c).toBeTruthy();`,
				`});`,
			].join("\n"),
		});
		const r = runAudit(root, true);
		expect(r.code).toBe(1);
		expect(r.out).toContain("P5");
		expect(r.out).toMatch(/UNGATED/i);
	});

	test("a path-injected (GUARDED) loadModelTierConfig call does NOT block", () => {
		const root = fixtureTree({
			"guarded-config-loader.test.ts": [
				`import { test } from "bun:test";`,
				`import { mkdtempSync } from "node:fs";`,
				`import { loadModelTierConfig } from "../../src/config";`,
				``,
				`test("x", () => {`,
				`  const cfgPath = mkdtempSync("/tmp/cfg");`,
				`  const c = loadModelTierConfig({ cfgPath }); // path-injected → GUARDED`,
				`  expect(c).toBeTruthy();`,
				`});`,
			].join("\n"),
		});
		const r = runAudit(root, true);
		expect(r.code).toBe(0);
	});

	test("a P2 host-binary spawn without a guard blocks under --strict", () => {
		const root = fixtureTree({
			"bad-spawn.test.ts": [
				`import { test } from "bun:test";`,
				`import { spawnSync } from "node:child_process";`,
				``,
				`test("x", () => {`,
				`  const r = spawnSync("git", ["init"]); // ungated host-binary probe`,
				`  expect(r.status).toBe(0);`,
				`});`,
			].join("\n"),
		});
		const r = runAudit(root, true);
		expect(r.code).toBe(1);
		expect(r.out).toContain("P2");
	});

	test("a P2 spawn guarded by process.execPath does NOT block", () => {
		const root = fixtureTree({
			"guarded-spawn.test.ts": [
				`import { test } from "bun:test";`,
				`import { spawnSync } from "node:child_process";`,
				``,
				`test("x", () => {`,
				`  const r = spawnSync(process.execPath, ["--version"]); // CI-safe target`,
				`  expect(r.status).toBe(0);`,
				`});`,
			].join("\n"),
		});
		const r = runAudit(root, true);
		expect(r.code).toBe(0);
	});

	test("a clean test file passes", () => {
		const root = fixtureTree({
			"clean.test.ts": [
				`import { test, expect } from "bun:test";`,
				`test("x", () => { expect(1).toBe(1); });`,
			].join("\n"),
		});
		const r = runAudit(root, true);
		expect(r.code).toBe(0);
	});
});
