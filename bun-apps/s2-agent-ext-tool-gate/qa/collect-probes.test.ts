/**
 * Gate-Recall Guard — collector drift guard (Task 2).
 *
 * Structural invariants over the collected probe sets (qa/collect-probes.ts):
 *   1. every probe targets a real CORPUS_GATES canonical name (names[0]);
 *   2. no two probe sets share a gating signature (one probe set per co-fire
 *      group — siblings like workflow/subagent fire together, so a single probe
 *      set covers the whole group);
 *   3. every probe set is well-formed (string gate, arrays, ≥1 control).
 *
 * While ALL_PROBE_SETS is empty (before Tasks 5–7 author the per-extension
 * `__GATE_PROBES__` exports) these loops are no-ops and the suite passes
 * trivially — that is expected and correct. The guard becomes meaningful once
 * probes land, catching a probe that references a renamed/removed gate or a
 * duplicate signature.
 */
import { test, expect } from "bun:test";
import { CORPUS_GATES } from "./evaluate.ts";
import { ALL_PROBE_SETS } from "./collect-probes.ts";

test("every probe targets a real CORPUS_GATES canonical name", () => {
	const canonical = new Set(CORPUS_GATES.map((g) => g.names[0]));
	for (const p of ALL_PROBE_SETS) {
		expect(canonical.has(p.gate), `probe gate '${p.gate}' not in CORPUS_GATES`).toBe(true);
	}
});

test("no two probe sets share a gating signature (one per co-fire group)", () => {
	const sig = (k: string[], r?: { nouns: string[]; verbs: string[] }) =>
		JSON.stringify({ keywords: k, requires: r });
	const byGate = new Map(CORPUS_GATES.map((g) => [g.names[0], g]));
	const seen = new Set<string>();
	for (const p of ALL_PROBE_SETS) {
		const gate = byGate.get(p.gate)!;
		const s = sig(gate.keywords, gate.requires);
		expect(seen.has(s), `duplicate probe set for signature of '${p.gate}'`).toBe(false);
		seen.add(s);
	}
});

test("every probe set is well-formed", () => {
	for (const p of ALL_PROBE_SETS) {
		expect(typeof p.gate).toBe("string");
		expect(Array.isArray(p.adversarial)).toBe(true);
		expect(Array.isArray(p.controls)).toBe(true);
		expect(p.controls.length).toBeGreaterThan(0);
	}
});
