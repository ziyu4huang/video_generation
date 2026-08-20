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
import { CORPUS_GATES } from "./evaluate.ts";
import { PROBES_BY_GATE } from "./collect-probes.ts";

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

// ── Harness: score every non-core gate group (Task 3) ───────────────────────

export interface GateRecallRow {
	gate: string;
	/** Every CORPUS_GATES name sharing this group's gating signature (co-fire siblings). */
	members: string[];
	recall: number;
	controlsPass: boolean;
	floor: number;
	misses: string[];
	controlFailures: string[];
	verdict: "PASS" | "FAIL";
}

export interface GateRecallReport {
	rows: GateRecallRow[];
	/** Group representative names (names[0]) whose signature has no probe set — UNCOVERED. */
	uncovered: string[];
	/** True iff every SCORED row passes. UNCOVERED gates never fail (they're unmeasured). */
	pass: boolean;
}

/** Structural signature of a gate's owner-declared gating — keywords + requires.
 *  Gates sharing a signature co-fire, so one probe set validates the whole group. */
const sigOf = (g: ToolGate): string => JSON.stringify({ keywords: g.keywords, requires: g.requires });

/**
 * Group CORPUS_GATES by gating signature (co-fire siblings share one predicate),
 * score each group that has a probe set, and list the rest as UNCOVERED. Pure:
 * no I/O, no LLM. With zero probe sets (pre-Tasks-5–7) every group is UNCOVERED,
 * `rows` is empty, and `pass` is true — so the qa/run.ts 4th conjunct stays green
 * until probes are authored, while the UNCOVERED list surfaces the coverage gap.
 */
export function evaluateGateRecall(): GateRecallReport {
	const groupRep = new Map<string, ToolGate>();
	const members = new Map<string, string[]>();
	for (const gate of CORPUS_GATES) {
		const s = sigOf(gate);
		if (!groupRep.has(s)) groupRep.set(s, gate);
		// Spread ALL names, not just names[0]: an id-grouped family gate (ticket
		// 01 reference form) carries its whole co-fire set in `names`; spreading
		// yields the same member list a set of single-name sibling gates produced
		// pre-migration, keeping the report byte-identical across the contract
		// change. (For legacy single-name gates names.length===1 — unchanged.)
		members.set(s, [...(members.get(s) ?? []), ...gate.names]);
	}
	const rows: GateRecallRow[] = [];
	const uncovered: string[] = [];
	for (const [s, rep] of groupRep) {
		const names = members.get(s)!;
		// A probe set may be keyed on ANY member name of the co-fire group.
		const probeSet = names.map((n) => PROBES_BY_GATE.get(n)).find((x) => x);
		if (!probeSet) {
			uncovered.push(rep.names[0]);
			continue;
		}
		const sc = scoreGate(rep, probeSet);
		rows.push({
			gate: probeSet.gate,
			members: names,
			recall: sc.recall,
			controlsPass: sc.controlsPass,
			floor: sc.floor,
			misses: sc.misses,
			controlFailures: sc.controlFailures,
			verdict: sc.verdict,
		});
	}
	return { rows, uncovered, pass: rows.every((r) => r.verdict === "PASS") };
}

/** Per-gate table + overall summary + UNCOVERED list. Exits non-zero on any FAIL. */
function main() {
	const r = evaluateGateRecall();
	const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
	const lines: string[] = [
		"═══════════════════════════════════════════════════════════════",
		" Gate-Recall Guard — adversarial recall over all non-core gates",
		"═══════════════════════════════════════════════════════════════",
	];
	for (const row of r.rows) {
		const ctrl = row.controlsPass ? "controls ok" : "CONTROL FAIL";
		const grp = row.members.length > 1 ? ` · group[${row.members.length}]` : "";
		lines.push(
			`${row.verdict === "PASS" ? "✅" : "❌"} ${row.gate.padEnd(34)} recall ${pct(row.recall)} (floor ${pct(row.floor)}) · ${ctrl}${grp}`,
		);
		for (const m of row.misses) lines.push(`     miss: "${m}"`);
		for (const c of row.controlFailures) lines.push(`     CONTROL MISS: "${c}"`);
	}
	if (r.uncovered.length)
		lines.push(``, `UNCOVERED (${r.uncovered.length} group(s) without probes): ${r.uncovered.join(", ")}`);
	lines.push(
		``,
		`${r.pass ? "✅ PASS" : "❌ FAIL"} — ${r.rows.filter((x) => x.verdict === "FAIL").length} failing gate(s), ${r.uncovered.length} uncovered`,
	);
	console.log(lines.join("\n"));
	process.exit(r.pass ? 0 : 1);
}

if (import.meta.main) main();
