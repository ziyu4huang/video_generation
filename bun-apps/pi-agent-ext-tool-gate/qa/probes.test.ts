/**
 * Layer-1 probe corpus — CI test form (wayfinder ticket 01/02).
 *
 * Thin wrapper over `evaluateCorpus()` (the single evaluator in ./evaluate.ts):
 * asserts each intended-behavior case passes, confirms the known-issue
 * registry, and logs the gap report. Run via `bun test` (auto-discovered).
 * The report form (./run.ts) consumes the same evaluator, so scoring lives in
 * exactly one place.
 */
import { describe, test, expect } from "bun:test";
import { evaluateCorpus } from "./evaluate.ts";

describe("L1 corpus — MUST_FIRE (intent → gate fires)", () => {
	for (const c of evaluateCorpus().mustFire) {
		test(`${c.gate}: "${c.input}"`, () => expect(c.pass).toBe(true));
	}
});

describe("L1 corpus — MUST_NOT_FIRE (lookalike → gate stays dormant)", () => {
	for (const c of evaluateCorpus().mustNotFire) {
		test(`${c.gate}: "${c.input}"`, () => expect(c.pass).toBe(true));
	}
});

describe("L1 corpus — ESCAPE_NAME (enable_tool {name} reaches every gate)", () => {
	for (const c of evaluateCorpus().escapeName) {
		test(`${c.gate} ← name "${c.input}"`, () => expect(c.pass).toBe(true));
	}
});

describe("L1 corpus — ESCAPE_INTENT (enable_tool {intent} surfaces the gate)", () => {
	for (const c of evaluateCorpus().escapeIntent) {
		test(`${c.gate} ← intent "${c.input}"`, () => expect(c.pass).toBe(true));
	}
});

describe("L1 corpus — ESCAPE_INTENT_BLIND (intent-mode cannot reach; name-only)", () => {
	for (const b of evaluateCorpus().blindIntents) {
		test(`${b.gate} ✗ intent "${b.intent}"`, () => expect(b.unreachable).toBe(true));
	}
});

describe("L1 corpus — PRECISION_RISKS (known false-fires; red only when fixed)", () => {
	for (const r of evaluateCorpus().precisionRisks) {
		test(`[known false-fire] ${r.gate}: "${r.prompt}" fires today`, () => {
			expect(r.fires).toBe(true);
		});
	}
});

describe("L1 corpus — OVERLAPS (keyword claimed by ≥2 gates)", () => {
	for (const o of evaluateCorpus().overlaps) {
		test(`"${o.keyword}" fires ${o.gates.join(" + ")}`, () => {
			expect(o.allFire).toBe(true);
		});
	}
});

describe("L1 corpus — report", () => {
	test("coverage + gap report (see test output)", () => {
		const r = evaluateCorpus();
		const lines: string[] = [
			"\n──── L1 probe report ────",
			`must-fire: ${r.mustFire.filter((c) => c.pass).length}/${r.mustFire.length}  ·  must-not-fire: ${r.mustNotFire.filter((c) => c.pass).length}/${r.mustNotFire.length}`,
			`escape-name: ${r.escapeName.filter((c) => c.pass).length}/${r.escapeName.length}  ·  escape-intent: ${r.escapeIntent.filter((c) => c.pass).length}/${r.escapeIntent.length}`,
			`coverage gaps: ${r.coverageGaps.length ? r.coverageGaps.join(", ") : "none"}`,
			``,
			`PRECISION RISKS (${r.precisionRisks.filter((x) => x.fires).length}):`,
			...r.precisionRisks.filter((x) => x.fires).map((x) => `  [${x.severity}] ${x.gate}: "${x.prompt}" — ${x.why}`),
			``,
			`ESCAPE INTENT BLIND (${r.blindIntents.filter((x) => x.unreachable).length}):`,
			...r.blindIntents.filter((x) => x.unreachable).map((x) => `  ${x.gate}: "${x.intent}" — ${x.note}`),
			``,
			`OVERLAPS (${r.overlaps.length}):`,
			...r.overlaps.map((o) => `  "${o.keyword}" → ${o.gates.join(" + ")}`),
			"──── end report ────",
		];
		process.stderr.write(lines.join("\n") + "\n");
		// Actionable on purpose. This assertion fires in tool-gate, but the repair
		// almost always belongs to the package that shipped the gated tool — when
		// `browser` (#1544) landed uncovered, main stayed red while the fix was
		// hunted for here instead of there.
		expect(
			r.coverageGaps,
			r.coverageGaps.length
				? `gate(s) with no L1 coverage: ${r.coverageGaps.join(", ")}.\n` +
					"Fix in the package that OWNS the gate, not here: export a\n" +
					"`__GATE_PROBES__` object beside its GATE_DEFS entry with `controls`\n" +
					"(must fire) and `mustNotFire` (lookalikes it must reject), then add\n" +
					"one import line to qa/collect-probes.ts. See browser-tool.ts."
				: undefined,
		).toEqual([]);
	});
});
