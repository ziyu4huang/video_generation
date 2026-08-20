/**
 * Gate-Recall Guard — unit tests for the pure `scoreGate` scorer (Task 1).
 *
 * Synthetic gates (no CORPUS_GATES dependency) exercising the four score
 * shapes: PASS (recall ≥ floor + controls ok), FAIL (recall < floor),
 * broken-control (always FAIL regardless of recall), and controls-only
 * (empty adversarial → recall 1, verdict = controlsPass). Deterministic — no
 * LLM, no telemetry. `evaluateGateRecall` + regression tests appended in
 * Task 3.
 */
import { test, expect } from "bun:test";
import { scoreGate } from "./gate-recall.ts";
import type { ToolGate } from "../extensions/tool-gate.ts";

const g = (keywords: string[], requires?: { nouns: string[]; verbs: string[] }): ToolGate => ({
	names: ["t"],
	keywords,
	description: "",
	requires,
});

test("PASS: recall ≥ floor and controls fire", () => {
	const gate = g(["flux"], { nouns: ["image"], verbs: ["render"] });
	const r = scoreGate(gate, {
		gate: "t",
		recallFloor: 0.5,
		adversarial: ["render an image", "render an image too"],
		controls: ["flux"],
	});
	expect(r.recall).toBe(1);
	expect(r.controlsPass).toBe(true);
	expect(r.verdict).toBe("PASS");
});

test("FAIL: recall below floor", () => {
	const gate = g(["flux"], { nouns: ["image"], verbs: ["render"] });
	const r = scoreGate(gate, {
		gate: "t",
		recallFloor: 0.9,
		adversarial: ["render an image", "draw a picture no noun verb match here oops"],
		controls: ["flux"],
	});
	// "draw a picture..." has noun picture but no listed verb → misses
	expect(r.verdict).toBe("FAIL");
	expect(r.misses.length).toBe(1);
});

test("FATAL: a control that does not fire is always FAIL", () => {
	const gate = g(["flux"], { nouns: ["image"], verbs: ["render"] });
	const r = scoreGate(gate, {
		gate: "t",
		recallFloor: 0,
		adversarial: [],
		controls: ["this-has-no-keyword-or-nounverb"],
	});
	expect(r.controlsPass).toBe(false);
	expect(r.verdict).toBe("FAIL");
	expect(r.controlFailures.length).toBe(1);
});

test("controls-only gate (empty adversarial) → recall 1, verdict = controlsPass", () => {
	const gate = g(["workflow"]);
	const r = scoreGate(gate, { gate: "t", recallFloor: 0, adversarial: [], controls: ["workflow"] });
	expect(r.recall).toBe(1);
	expect(r.verdict).toBe("PASS");
});

// ── evaluateGateRecall (Task 3) ────────────────────────────────────────────

import { evaluateGateRecall } from "./gate-recall.ts";
import { CORPUS_GATES } from "./evaluate.ts";

test("evaluateGateRecall: every signature-group is either scored or uncovered", () => {
	// Durable invariant (holds pre-probes, mid-rollout, and fully calibrated):
	// each CORPUS_GATES signature-group appears in exactly one of `rows` (has a
	// probe set, scored) or `uncovered` (no probe set, listed). `pass` simply
	// mirrors whether every SCORED row passed — UNCOVERED groups never fail
	// (they're unmeasured), so with zero probes pass is vacuously true (keeps
	// the qa/run.ts 4th conjunct green pre-Tasks-5–7); once probes land, pass
	// reflects the real per-gate recall vs floor.
	const sig = (k: string[], req?: { nouns: string[]; verbs: string[] }) =>
		JSON.stringify({ keywords: k, requires: req });
	const groupCount = new Set(CORPUS_GATES.map((g) => sig(g.keywords, g.requires))).size;
	const r = evaluateGateRecall();
	expect(Array.isArray(r.uncovered)).toBe(true);
	expect(r.rows.length + r.uncovered.length).toBe(groupCount);
	expect(r.pass).toBe(r.rows.every((row) => row.verdict === "PASS"));
});

test("regression: removing a keyword turns a PASS row red", () => {
	// Build a gate + probe mirroring a real crisp gate, then weaken it. The
	// guard MUST go red when an adversarial phrasing that relied on a removed
	// keyword/verb stops firing.
	const strong = g(["flux"], { nouns: ["image"], verbs: ["render"] });
	const weak = g(["flux"], { nouns: ["image"], verbs: ["__never__"] }); // verb removed
	const probes = { gate: "t", recallFloor: 0.9, adversarial: ["render an image"], controls: ["flux"] };
	expect(scoreGate(strong, probes).verdict).toBe("PASS");
	expect(scoreGate(weak, probes).verdict).toBe("FAIL");
});
