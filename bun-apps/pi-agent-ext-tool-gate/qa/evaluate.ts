/**
 * Corpus evaluator (wayfinder ticket 02) — the single source of truth for how
 * the L1 probe corpus (./probes.ts) is scored. Both the bun:test form
 * (./probes.test.ts) and the report form (./run.ts) consume `evaluateCorpus()`,
 * so the pass/fail logic lives in exactly one place.
 *
 * Pure: imports the corpus + tool-gate's pure exports (gateFires / matchIntent /
 * GATES). No agent run, no LLM.
 */
import { GATES, gateFires, matchIntent } from "../extensions/tool-gate.ts";
import {
	MUST_FIRE,
	MUST_NOT_FIRE,
	ESCAPE_NAME,
	ESCAPE_INTENT,
	ESCAPE_INTENT_BLIND,
	PRECISION_RISKS,
	OVERLAPS,
} from "./probes.ts";

export interface CaseResult {
	gate: string;
	input: string;
	/** True iff the case met its intended expectation. */
	pass: boolean;
	note?: string;
}

const findGate = (id: string) => {
	const g = GATES.find((x) => x.names[0] === id);
	if (!g) throw new Error(`probe references unknown gate '${id}'`);
	return g;
};

export interface CorpusResult {
	/** Intended behavior (gates the default `bun run qa`). */
	mustFire: CaseResult[];
	mustNotFire: CaseResult[];
	escapeName: CaseResult[];
	escapeIntent: CaseResult[];
	/** Known-issue registry (reported always; gates only under `--strict`). */
	precisionRisks: { gate: string; prompt: string; fires: boolean; severity: string; why: string }[];
	blindIntents: { gate: string; intent: string; unreachable: boolean; note: string }[];
	overlaps: { keyword: string; gates: string[]; allFire: boolean }[];
	/** Gates lacking a must-fire or must-not-fire case. */
	coverageGaps: string[];
	/** Every intended-behavior case passed. */
	intendedPass: boolean;
	/** Gates that are task-breaking under ON: blind (intent-mode can't reach)
	 *  and/or misroute. Drawn from L1 blind intents; L2 (when run) corroborates
	 *  at task level. False-fires are NOT here — they're benign (never gate). */
	taskBreakingGates: string[];
	/** Confirmed known issues (precision risks that fire + blind intent gates). */
	knownIssueCount: number;
}

/** Evaluate the full L1 corpus against tool-gate's current keyword/gate logic. */
export function evaluateCorpus(): CorpusResult {
	const emptySticky = new Set<string>();

	const mustFire: CaseResult[] = MUST_FIRE.map((p) => ({
		gate: p.gate,
		input: p.prompt,
		pass: gateFires(findGate(p.gate), p.prompt.toLowerCase()),
		note: p.note,
	}));
	const mustNotFire: CaseResult[] = MUST_NOT_FIRE.map((p) => ({
		gate: p.gate,
		input: p.prompt,
		pass: !gateFires(findGate(p.gate), p.prompt.toLowerCase()),
		note: p.note,
	}));
	const escapeName: CaseResult[] = ESCAPE_NAME.map(({ gate, name }) => {
		const resolved = GATES.find((g) => g.names.includes(name));
		return { gate, input: name, pass: resolved?.names[0] === gate };
	});
	const escapeIntent: CaseResult[] = ESCAPE_INTENT.map((p) => {
		const matched = matchIntent(p.intent, GATES, emptySticky);
		return { gate: p.gate, input: p.intent, pass: matched.some((g) => g.names[0] === p.gate), note: p.note };
	});

	const precisionRisks = PRECISION_RISKS.map((r) => ({
		gate: r.gate,
		prompt: r.prompt,
		fires: gateFires(findGate(r.gate), r.prompt.toLowerCase()),
		severity: r.severity,
		why: r.why,
	}));
	const blindIntents = ESCAPE_INTENT_BLIND.map((p) => {
		const matched = matchIntent(p.intent, GATES, emptySticky);
		return { gate: p.gate, intent: p.intent, unreachable: !matched.some((g) => g.names[0] === p.gate), note: p.note };
	});
	const overlaps = OVERLAPS.map((o) => ({
		keyword: o.keyword,
		gates: o.gates,
		allFire: o.gates.every((id) => gateFires(findGate(id), o.keyword.toLowerCase())),
	}));

	const gateIds = GATES.map((g) => g.names[0]);
	const mfHas = new Set(MUST_FIRE.map((p) => p.gate));
	const mnfHas = new Set(MUST_NOT_FIRE.map((p) => p.gate));
	const coverageGaps = gateIds.filter((id) => !mfHas.has(id) || !mnfHas.has(id));

	const intendedPass =
		[...mustFire, ...mustNotFire, ...escapeName, ...escapeIntent].every((c) => c.pass) &&
		coverageGaps.length === 0;
	const taskBreakingGates = [...new Set(blindIntents.filter((b) => b.unreachable).map((b) => b.gate))];
	const knownIssueCount =
		precisionRisks.filter((r) => r.fires).length + blindIntents.filter((b) => b.unreachable).length;

	return {
		mustFire,
		mustNotFire,
		escapeName,
		escapeIntent,
		precisionRisks,
		blindIntents,
		overlaps,
		coverageGaps,
		intendedPass,
		taskBreakingGates,
		knownIssueCount,
	};
}

/** Compact one-line summaries, e.g. "must-fire: 27/27". */
export const tally = (cases: CaseResult[]): string =>
	`${cases.filter((c) => c.pass).length}/${cases.length}`;
