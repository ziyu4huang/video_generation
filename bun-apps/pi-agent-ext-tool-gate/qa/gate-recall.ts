/**
 * Gate-Recall Guard — pure scorer (Task 1) + harness (Task 3).
 *
 * Replaces the dead `qa/miss-rate-ab.ts` (hardwired to ask_user_question/todo,
 * both `core:true` since #5's revert → it threw "unknown gate"). This measures
 * every non-core keyword gate's adversarial recall against owner-declared probe
 * sets, fails on regression, and runs as the 4th conjunct of `bun run qa`.
 *
 * Machinery: reuses the REAL `gateFires(gate, promptLower)` from
 * extensions/tool-gate.ts (the pure per-gate fire test the runtime calls every
 * turn) — never reimplements keyword matching. A score is therefore an exact
 * replay of what production does on a given prompt.
 *
 * Verdict model (plan, refined from spec):
 *   - scoreGate: {PASS, FAIL}. recall = adversarial-fired/adversarial-total;
 *     PASS iff recall ≥ recallFloor AND every control fired. A control that
 *     fails to fire is ALWAYS a FAIL (controlsPass:false) — the keyword set is
 *     broken, independent of recallFloor. (The spec called this FATAL; the plan
 *     folds it into FAIL, distinguished by `controlsPass`/`controlFailures`.)
 *   - evaluateGateRecall: a gate with NO probe set is UNCOVERED — listed
 *     separately, never scored (cannot measure). With zero probes the overall
 *     result is PASS (nothing failed) so the qa/run.ts 4th conjunct stays green.
 */
import { gateFires, type ToolGate } from "../extensions/tool-gate.ts";
import type { GateProbeSet } from "./collect-probes.ts";

/** Default adversarial-recall floor when a probe set omits `recallFloor`. */
export const DEFAULT_FLOOR = 0.9;

export interface GateScore {
	/** Adversarial recall fraction (1.0 when adversarial is empty). */
	recall: number;
	/** True iff every control prompt fired (false ⇒ the gate's keyword set is broken). */
	controlsPass: boolean;
	/** Adversarial prompts that did NOT fire (recall misses). */
	misses: string[];
	/** Control prompts that did NOT fire (always fatal regardless of floor). */
	controlFailures: string[];
	/** Effective floor (probe-set value or DEFAULT_FLOOR). */
	floor: number;
	verdict: "PASS" | "FAIL";
}

/**
 * Pure: score one gate against one probe set using the REAL `gateFires`.
 * `verdict` is PASS iff recall ≥ floor AND every control fired. A control miss
 * is always FAIL (broken keyword set), independent of `recallFloor`. Empty
 * adversarial → recall 1 (a controls-only gate).
 */
export function scoreGate(gate: ToolGate, p: GateProbeSet): GateScore {
	const floor = p.recallFloor ?? DEFAULT_FLOOR;
	const misses: string[] = [];
	let fired = 0;
	for (const prompt of p.adversarial) {
		if (gateFires(gate, prompt.toLowerCase())) fired++;
		else misses.push(prompt);
	}
	const controlFailures: string[] = [];
	for (const c of p.controls) {
		if (!gateFires(gate, c.toLowerCase())) controlFailures.push(c);
	}
	const recall = p.adversarial.length === 0 ? 1 : fired / p.adversarial.length;
	const controlsPass = controlFailures.length === 0;
	return {
		recall,
		controlsPass,
		misses,
		controlFailures,
		floor,
		verdict: controlsPass && recall >= floor ? "PASS" : "FAIL",
	};
}
