/**
 * L1 corpus derivation — extension-owned probes feed the L1 gate corpus.
 *
 * The architectural point: a newly gated tool must be fully coverable from the
 * package that OWNS it. Before this seam, `qa/probes.ts` was a hand-maintained
 * mirror inside tool-gate, so shipping a gated tool in package X turned
 * tool-gate red and the repair landed in a package X's author does not own
 * (observed 2026-08-16: the `browser` tool from #1544 left main red).
 *
 * `controls` already means "carries a keyword — MUST fire", which is exactly
 * L1's must-fire. So must-fire DERIVES from the existing field rather than
 * introducing a third probe concept; only must-not-fire needed a new one.
 */
import { test, expect, describe } from "bun:test";
import { deriveL1Cases, type GateProbeSet } from "./collect-probes.ts";

const set = (over: Partial<GateProbeSet> = {}): GateProbeSet => ({
	gate: "demo",
	adversarial: [],
	controls: ["use the demo tool"],
	...over,
});

describe("deriveL1Cases", () => {
	test("derives a must-fire case from every control", () => {
		const { mustFire } = deriveL1Cases([set({ controls: ["a prompt", "b prompt"] })]);
		expect(mustFire.map((p) => p.prompt)).toEqual(["a prompt", "b prompt"]);
		expect(mustFire.every((p) => p.gate === "demo")).toBe(true);
	});

	test("derives a must-not-fire case from every mustNotFire entry", () => {
		const { mustNotFire } = deriveL1Cases([set({ mustNotFire: ["a lookalike"] })]);
		expect(mustNotFire).toEqual([
			{ gate: "demo", prompt: "a lookalike", note: "owned by the extension (__GATE_PROBES__)" },
		]);
	});

	test("omits must-not-fire entirely when the extension declares none", () => {
		expect(deriveL1Cases([set()]).mustNotFire).toEqual([]);
	});

	test("attributes every derived case so a failure names its source", () => {
		const { mustFire } = deriveL1Cases([set()]);
		expect(mustFire[0]!.note).toContain("__GATE_PROBES__");
	});

	test("is pure — an empty collection derives nothing, never throws", () => {
		expect(deriveL1Cases([])).toEqual({ mustFire: [], mustNotFire: [] });
	});
});
