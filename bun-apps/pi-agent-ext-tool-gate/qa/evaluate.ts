/**
 * Corpus evaluator (wayfinder ticket 02) — the single source of truth for how
 * the L1 probe corpus (./probes.ts) is scored. Both the bun:test form
 * (./probes.test.ts) and the report form (./run.ts) consume `evaluateCorpus()`,
 * so the pass/fail logic lives in exactly one place.
 *
 * Pure: imports the corpus + tool-gate's pure exports (gateFires / matchIntent /
 * GATES) + the migrated extensions' registrars (captured via a stub `pi` to
 * reconstruct their owner-declared gates — see reconstructOwnerDeclaredGates).
 * No agent run, no LLM.
 */
import { GATES, gateFires, matchIntent } from "../extensions/tool-gate.ts";
import deployDefault from "@repo/pi-agent-ext-deploy";
import file2mdDefault from "@repo/pi-agent-ext-file2md/extensions/file2md.ts";
import flux2Default from "@repo/pi-agent-ext-flux2/extensions/flux2.ts";
import krea2Default from "@repo/pi-agent-ext-krea2/extensions/krea2.ts";
import ltxDefault from "@repo/pi-agent-ext-ltx/extensions/ltx.ts";
import movieDefault from "@repo/pi-agent-ext-movie-director/extensions/movie-director.ts";
import {
	MUST_FIRE,
	MUST_NOT_FIRE,
	ESCAPE_NAME,
	ESCAPE_INTENT,
	ESCAPE_INTENT_BLIND,
	PRECISION_RISKS,
	OVERLAPS,
} from "./probes.ts";

/** Structural shape of a gate (== the non-exported tool-gate `ToolGate`). */
type CorpusGate = (typeof GATES)[number];

/** A captured tool def — only the fields the gate reconstruction reads. */
type CapturedDef = {
	name?: string;
	description?: string;
	gating?: { core?: boolean; keywords?: string[]; requires?: { nouns?: string[]; verbs?: string[] } };
};

/**
 * Run each migrated extension's registrar against a capturing stub `pi` and
 * return the tool defs it registers (mirrors drift-guard.test.ts's
 * captureRegisteredTools). The stub is a Proxy whose `registerTool` captures
 * defs; everything else is a no-op so a factory that probes ancillary API
 * surface never throws.
 */
function captureOwnerDeclaredDefs(registrars: Array<(pi: any) => void>): CapturedDef[] {
	const captured: CapturedDef[] = [];
	const noop = (): undefined => undefined;
	const eventsStub = new Proxy({} as Record<string, unknown>, { get: () => noop });
	const pi = new Proxy({} as Record<string, unknown>, {
		get(_t, prop) {
			if (prop === "registerTool")
				return (def: CapturedDef) => {
					captured.push(def);
					return def;
				};
			if (prop === "on") return () => noop;
			if (prop === "getAllTools" || prop === "getAllToolDefinitions") return () => [];
			if (prop === "events") return eventsStub;
			return noop;
		},
	}) as any;
	for (const r of registrars) r(pi);
	return captured;
}

/**
 * Reconstruct multi-name gates from owner-declared `gating`: tool names sharing
 * an identical gating signature (keywords + requires) collapse into ONE gate
 * (the SAME model the hardcoded GATES uses, characterized by names[0]). This is
 * the semantics-preserving inverse of the rollout migration — a former
 * `{names:["pi_deploy","pi_verify"], keywords, requires}` hardcoded gate that
 * migrated to identical per-tool `gating` reconstructs back into the identical
 * multi-name gate, so the probe suite keeps validating firing behavior
 * unchanged regardless of where a gate is declared. Core tools (gating.core)
 * are always-active, not gates, so they're excluded.
 *
 * SCALE: a rollout ticket appends its migrated extension's registrar to the
 * list below (mirrors drift-guard.test.ts MIGRATED_EXTENSIONS); its former
 * gate reconstructs here and its probes stay live with NO probe edits. Sibling
 * names stay characterized by names[0] — no per-sibling probe explosion.
 */
function reconstructOwnerDeclaredGates(registrars: Array<(pi: any) => void>): CorpusGate[] {
	const defs = captureOwnerDeclaredDefs(registrars);
	const bySig = new Map<string, CorpusGate>();
	for (const d of defs) {
		const g = d.gating;
		if (!g || !d.name || g.core === true) continue; // core = always-active, not a gate
		const sig = JSON.stringify({ k: g.keywords ?? [], r: g.requires ?? {} });
		const existing = bySig.get(sig);
		if (existing) existing.names.push(d.name);
		else
			bySig.set(sig, {
				names: [d.name],
				keywords: g.keywords ?? [],
				requires: g.requires,
				description: d.description ?? "",
			});
	}
	return [...bySig.values()];
}

/**
 * The gate set the corpus evaluates against: the remaining hardcoded GATES +
 * reconstructed owner-declared gates (migrated extensions). Same multi-name
 * model either way; appending a migrated extension's registrar to the list
 * keeps its probes live here. Single source of truth for every reference below
 * (findGate / escapeName / matchIntent / coverage).
 */
export const CORPUS_GATES: CorpusGate[] = [...GATES, ...reconstructOwnerDeclaredGates([deployDefault, file2mdDefault, flux2Default, krea2Default, ltxDefault, movieDefault])];

export interface CaseResult {
	gate: string;
	input: string;
	/** True iff the case met its intended expectation. */
	pass: boolean;
	note?: string;
}

const findGate = (id: string) => {
	const g = CORPUS_GATES.find((x) => x.names[0] === id);
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
		const resolved = CORPUS_GATES.find((g) => g.names.includes(name));
		return { gate, input: name, pass: resolved?.names[0] === gate };
	});
	const escapeIntent: CaseResult[] = ESCAPE_INTENT.map((p) => {
		const matched = matchIntent(p.intent, CORPUS_GATES, emptySticky);
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
		const matched = matchIntent(p.intent, CORPUS_GATES, emptySticky);
		return { gate: p.gate, intent: p.intent, unreachable: !matched.some((g) => g.names[0] === p.gate), note: p.note };
	});
	const overlaps = OVERLAPS.map((o) => ({
		keyword: o.keyword,
		gates: o.gates,
		allFire: o.gates.every((id) => gateFires(findGate(id), o.keyword.toLowerCase())),
	}));

	const gateIds = CORPUS_GATES.map((g) => g.names[0]);
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
