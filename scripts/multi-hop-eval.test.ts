/**
 * multi-hop-eval.test.ts — e2e guard for the leak-free multi-hop eval ruler.
 *
 * Cycle 2's central deliverable is a VALID ruler: a leak-free multi-hop eval that
 * the lever measurements are judged against. This test guards that ruler against
 * regressions in three layers:
 *
 *   L1 STRUCTURE  — eval JSON integrity + design invariants. ALWAYS RUNS, no vault
 *                   needed. Catches "someone edited a query and broke the shape".
 *   L2 LEAK GATE  — shells out to the REAL leakcheck script (the acceptance gate
 *                   from Track A.1). Asserts every bridge-overlap < 0.30. SKIPS
 *                   when the knowledge-graph vault is absent (CI).
 *   L3 BASELINE   — shells out to the REAL measure script (exercises the real
 *                   deterministic retrieveRecords path). Asserts the recorded
 *                   baseline reproduces ±0. SKIPS when the vault is absent (CI).
 *
 * L2/L3 shell out to the scripts AS SHIPPED rather than importing their internals
 * (the scripts are self-executing .mjs side-effect modules). That makes this a
 * genuine e2e: it exercises the exact code path a human runs.
 *
 * Co-located with the eval assets (scripts/drawthings-bench.test.ts precedent).
 *
 *   bun test scripts/multi-hop-eval.test.ts
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO = process.cwd();
const EVAL_FILE = join(REPO, "scripts/multi-hop-eval.json");
const evalSet = JSON.parse(readFileSync(EVAL_FILE, "utf8")) as {
	queries: Array<{
		q: string;
		anchor: string;
		expect: string[];
		bridgeTag: string;
		bridge: string;
		why: string;
		sources: string[];
	}>;
	_meta?: { baseline?: Record<string, number> };
};

// ---------------------------------------------------------------------------
// Vault-present guard for L2/L3. resolveVault runs for real here (no obsidian
// mock in this file), mirroring what the measure/leakcheck scripts do at runtime.
// ---------------------------------------------------------------------------
let vaultPresent = false;
try {
	const { resolveVault } = await import(
		"../bun-apps/s2-agent-ext-obsidian/extensions/obsidian.ts"
	);
	const vault = (await resolveVault(REPO)).path;
	vaultPresent = existsSync(join(vault, "Zettelkasten/knowledge-graph"));
} catch {
	vaultPresent = false;
}

/** Run a repo script under `bun`, return {status, stdout, stderr}. */
function runScript(rel: string) {
	return spawnSync("bun", [rel], { cwd: REPO, encoding: "utf8", timeout: 120_000 });
}

// ===========================================================================
// L1 — STRUCTURE (always runs; the regression guard that needs no vault)
// ===========================================================================

describe("L1 — multi-hop-eval.json structural integrity", () => {
	test("has exactly 16 queries", () => {
		expect(evalSet.queries.length).toBe(16);
	});

	test("every query has the required fields with correct types", () => {
		for (let i = 0; i < evalSet.queries.length; i++) {
			const q = evalSet.queries[i];
			const label = `Q${i + 1}`;
			expect(typeof q.q, `${label}.q is a non-empty string`).toBe("string");
			expect(q.q.length, `${label}.q non-empty`).toBeGreaterThan(0);
			expect(typeof q.anchor, `${label}.anchor`).toBe("string");
			expect(Array.isArray(q.expect), `${label}.expect is array`).toBe(true);
			expect(typeof q.bridge, `${label}.bridge`).toBe("string");
			expect(typeof q.bridgeTag, `${label}.bridgeTag`).toBe("string");
			expect(Array.isArray(q.sources), `${label}.sources is array`).toBe(true);
		}
	});

	test("anchor (expect[0]) is the first expected card, and expect is unique", () => {
		for (let i = 0; i < evalSet.queries.length; i++) {
			const q = evalSet.queries[i];
			expect(q.expect[0], `Q${i + 1} anchor===expect[0]`).toBe(q.anchor);
			expect(new Set(q.expect).size, `Q${i + 1} expect unique`).toBe(q.expect.length);
		}
	});

	test("every query expects >=2 cards (anchor + bridge = multi-hop)", () => {
		for (let i = 0; i < evalSet.queries.length; i++) {
			expect(evalSet.queries[i].expect.length, `Q${i + 1} expect>=2`).toBeGreaterThanOrEqual(2);
		}
	});

	test("every bridge tag is DOT-FREE (queryToTags strips dots → unmatchable if dotted)", () => {
		for (let i = 0; i < evalSet.queries.length; i++) {
			const b = evalSet.queries[i].bridge;
			expect(b.includes("."), `Q${i + 1} bridge "${b}" must be dot-free`).toBe(false);
			expect(evalSet.queries[i].bridgeTag, `Q${i + 1} bridgeTag===bridge`).toBe(b);
		}
	});

	test("every query LEADS WITH its bridge tag (so both cards enter the tag-path pool)", () => {
		for (let i = 0; i < evalSet.queries.length; i++) {
			const q = evalSet.queries[i];
			const ql = q.q.toLowerCase();
			const bridgeSpace = q.bridge.toLowerCase().replace(/-/g, " ");
			const bridgeLiteral = q.bridge.toLowerCase();
			expect(
				ql.includes(bridgeSpace) || ql.includes(bridgeLiteral),
				`Q${i + 1} query must contain bridge tag "${q.bridge}"`,
			).toBe(true);
		}
	});

	test("every expected card has a resolved source (sources.length === expect.length)", () => {
		for (let i = 0; i < evalSet.queries.length; i++) {
			const q = evalSet.queries[i];
			expect(q.sources.length, `Q${i + 1} one source per expected card`).toBe(q.expect.length);
			expect(q.sources.every((s) => typeof s === "string" && s.length > 0), `Q${i + 1} no empty sources`).toBe(true);
		}
	});

	test("_meta.baseline records the declared gate metric (fullRecall@4 = 0.375)", () => {
		const b = evalSet._meta?.baseline ?? {};
		expect(b["setRecall@4"]).toBe(0.688);
		expect(b["fullRecall@4"]).toBe(0.375);
		expect(b["fullRecall@8"]).toBe(0.625);
		expect(b["bridgeLift_4to8"]).toBe(0.125);
	});
});

// ===========================================================================
// L2 — LEAK GATE (e2e: the real leakcheck script; skip if no vault)
// ===========================================================================

(vaultPresent ? describe : describe.skip)("L2 — leakcheck acceptance gate (real vault)", () => {
	test("the eval is LEAK-FREE: every bridge-overlap < 0.30 (exit 0, PASS)", () => {
		const r = runScript("scripts/multi-hop-eval-leakcheck.mjs");
		expect(r.status, `leakcheck exit code\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
		expect(r.stdout).toContain("PASS");
		expect(r.stdout).not.toContain("LEAKS");
		// mean bridge-overlap must be well under the 0.30 gate
		const m = r.stdout.match(/mean bridge-overlap = ([\d.]+)/);
		expect(m, "mean bridge-overlap line present").not.toBeNull();
		expect(Number(m![1])).toBeLessThan(0.30);
		// and the anchor side must be high (queries genuinely name card 1)
		const am = r.stdout.match(/mean anchor-overlap = ([\d.]+)/);
		expect(Number(am![1])).toBeGreaterThan(0.30);
	});
});

// ===========================================================================
// L3 — BASELINE (e2e: the real measure script; deterministic ±0; skip if no vault)
// ===========================================================================

(vaultPresent ? describe : describe.skip)("L3 — deterministic baseline reproduces (real retrieval path)", () => {
	test("setRecall@4 and fullRecall@4 match the recorded baseline ±0", () => {
		const r = runScript("scripts/multi-hop-measure.mjs");
		expect(r.status, `measure exit code\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);

		const setR = r.stdout.match(/setRecall@4\s*=\s*([\d.]+)/);
		const fullR = r.stdout.match(/fullRecall@4\s*=\s*([\d.]+)/);
		expect(setR, "setRecall@4 line present").not.toBeNull();
		expect(fullR, "fullRecall@4 line present").not.toBeNull();

		// The deterministic contract: retrieval is tag-path only (no model noise),
		// so these reproduce EXACTLY run-to-run. Drift = a retrieval change slipped in.
		expect(Number(setR![1]), "setRecall@4 baseline 0.688").toBeCloseTo(0.688, 3);
		expect(Number(fullR![1]), "fullRecall@4 baseline 0.375 (the gate metric)").toBeCloseTo(0.375, 3);
	});

	test("rerank ablation stays RETIRED (Δ <= 0 — content-rerank does not beat baseline)", () => {
		const r = runScript("scripts/multi-hop-measure.mjs");
		expect(r.status).toBe(0);
		const d = r.stdout.match(/setRecall@4\s+baseline=[\d.]+\s+rerank=[\d.]+\s+Δ=(-?[\d.]+)/);
		expect(d, "rerank ablation Δ line present").not.toBeNull();
		expect(Number(d![1]), "rerank Δ must not be positive (retired)").toBeLessThanOrEqual(0);
	});
});
