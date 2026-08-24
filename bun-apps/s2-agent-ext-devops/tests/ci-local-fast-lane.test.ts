/**
 * ci-local fast-lane regression — the 2026-08-24 controllability asks, pinned.
 *
 * Three guards, one per seam that can silently rot:
 *
 *   1. EXCLUSIVE drift — with --jobs > 1, gates matching EXCLUSIVE_GATE_RE
 *      serialize (never two deploy-tree mutations at once). The regex lives
 *      inside the script; if the workflow renames the Deploy-sh gate, the
 *      regex stops matching NOTHING fails loudly — exclusivity is silently
 *      gone and a future second deploy-mutating gate would overlap it. This
 *      guard compiles the regex out of the script source and asserts it
 *      matches the workflow's actual Deploy-sh L1 label and nothing else.
 *
 *   2. Budget exhaustion FAILS — a skipped gate proves nothing, so a run that
 *      crosses --budget-ms must exit 1 with a BUDGET marker, never a green.
 *      Exercised for real against the light-gate prefix (bounded ~5s).
 *
 *   3. Roundtrip agent-dir isolation — the dev launcher writes prompt-history
 *      to the REAL ~/.pi/agent on every successful round trip; unisolated, it
 *      both leaks per-user state AND flaky-fails deploy-probe-e2e's isolation
 *      guard when the two suites run in the same `bun test` (measured
 *      2026-08-24: "probe leaked per-user writes ... e2e-write-*"). The fix
 *      (isolatedAgentDirEnv wired into runOnce's spawn env) is structural, so
 *      the pin is structural — same style as lint-executor coverage.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readCiGates } from "../src/ci-gates.ts";

const PKG_DIR = join(import.meta.dir, "..");
const SCRIPT = join(PKG_DIR, "scripts", "ci-local.ts");
const SOURCE = readFileSync(SCRIPT, "utf8");

describe("ci-local fast lane — EXCLUSIVE_GATE_RE drift guard", () => {
	test("the regex is extractable from the script source", () => {
		const m = SOURCE.match(/const EXCLUSIVE_GATE_RE = \/([^/]+)\/(i)?;/);
		expect(m, "EXCLUSIVE_GATE_RE literal not found in ci-local.ts — if it was renamed, update this guard").not.toBeNull();
	});

	test("it matches the workflow's Deploy-sh L1 gate and only that gate", async () => {
		const m = SOURCE.match(/const EXCLUSIVE_GATE_RE = \/([^/]+)\/(i)?;/);
		const re = new RegExp(m![1]!, m![2] ? "i" : "");
		const repoRoot = join(PKG_DIR, "..", "..");
		const { gates, error } = await readCiGates(repoRoot);
		expect(error, `workflow unreadable: ${error}`).toBeUndefined();
		const matched = gates.filter((g) => re.test(g.name));
		expect(
			matched.length,
			"EXCLUSIVE_GATE_RE must serialize exactly the deploy-tree gate. If it matches nothing, exclusivity is silently gone; if it matches extra gates, lanes are needlessly serialized.",
		).toBe(1);
		expect(matched[0]!.name).toContain("Deploy-sh L1");
	});
});

// Machine-coupled (spawns the real gates script against the real workflow):
// skipped under CI per .github/TEST-PORTABILITY.md — the structural pins above
// and below still run everywhere.
const describeExecutable = describe.skipIf(process.env.CI !== undefined);
describeExecutable("ci-local fast lane — budget exhaustion is a FAIL", () => {
	// 5s budget: the light gates (~0-1s each) that start before the clock
	// crosses finish; the rest — including the 99s Deploy-sh L1 — are skipped.
	// Bounded: the run exits as soon as the remaining gates are skipped.
	test("a crossed budget exits 1 with a loud BUDGET marker", () => {
		const r = spawnSync("bun", [SCRIPT, "--gates", "--budget-ms", "5000"], {
			cwd: PKG_DIR,
			env: { ...process.env, CI: "true" },
			encoding: "utf8",
			timeout: 60_000,
		});
		const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
		expect(r.status, `budget run should FAIL, got exit ${r.status}:\n${out.slice(-400)}`).toBe(1);
		expect(out).toContain("BUDGET EXHAUSTED");
		expect(out).toContain("Budget exhaustion is a FAIL, not a green");
	}, 90_000);
});

describe("ci-local fast lane — roundtrip agent-dir isolation pin", () => {
	test("e2e-core-tool-roundtrip isolates the dev launcher's agent dir", () => {
		const t = readFileSync(join(PKG_DIR, "tests", "e2e-core-tool-roundtrip.test.ts"), "utf8");
		expect(
			t.includes("isolatedAgentDirEnv(join(cwd, \"pi-home\"))"),
			"runOnce must spawn the dev launcher with an ISOLATED agent dir — an unisolated successful run writes prompt-history into the operator's REAL ~/.pi/agent and flaky-fails deploy-probe-e2e's isolation guard",
		).toBe(true);
		// The env name must be derived from package.json (piConfig.name), never
		// hardcoded — a rename would silently break isolation again (#1822).
		expect(t).toContain("piConfig");
	});
});
