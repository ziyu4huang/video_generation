/**
 * Corpus evaluator (wayfinder ticket 02) — the single source of truth for how
 * the L1 probe corpus (./probes.ts) is scored. Both the bun:test form
 * (./probes.test.ts) and the report form (./run.ts) consume `evaluateCorpus()`,
 * so the pass/fail logic lives in exactly one place.
 *
 * Pure: imports the corpus + tool-gate's pure exports (gateFires / matchIntent /
 * buildEffectiveGates) + the migrated extensions' registrars (captured via a
 * stub `pi` and fed to buildEffectiveGates — the same effective-gate builder
 * production runs at session_start). No agent run, no LLM.
 */
import { gateFires, matchIntent, buildEffectiveGates, type ToolGate } from "../extensions/tool-gate.ts";
import deployDefault from "@repo/pi-agent-ext-deploy";
import file2mdDefault from "@repo/pi-agent-ext-file2md/extensions/file2md.ts";
import flux2Default from "@repo/pi-agent-ext-flux2/extensions/flux2.ts";
import krea2Default from "@repo/pi-agent-ext-krea2/extensions/krea2.ts";
import ltxDefault from "@repo/pi-agent-ext-ltx/extensions/ltx.ts";
import movieDefault from "@repo/pi-agent-ext-movie-director/extensions/movie-director.ts";
import researchDefault from "@repo/pi-agent-ext-research-tool/extensions/research-tool.ts";
// ticket 13b — power-tool registers the 6 inspect_* diagnostics (inspect_context /
// inspect_agent / inspect_extensions / inspect_hooks / inspect_pathology / inspect_tui).
// All 6 declare IDENTICAL gating → ONE signature-group whose canonical names[0] is
// inspect_context (first registered). Capturing the registrar here promotes all 6
// into CORPUS_EFF (single-name effective gates) so qa/probes.ts covers the inspect
// group, and the --strict ungated count drops (inspect_pathology was previously
// un-captured → ungated; now it's gated like its 5 already-captured siblings).
import powerToolDefault from "@repo/pi-agent-ext-power-tool/extensions/power-tool.ts";
// tickets 10 + 11 (rolled out TOGETHER): the combined workflow/subagent gate.
// workflow is imported FIRST so it precedes subagent in capture order, keeping
// the canonical signature-group id "workflow" first (the id every qa/probes.ts
// entry + findGate keys off of) — see the comment at the CORPUS_EFF call site.
import workflowDefault from "@repo/pi-agent-ext-workflow/extensions/workflow.ts";
import subagentDefault from "@repo/pi-agent-ext-subagent/extensions/subagent.ts";
// ticket 12 — zai-mcp registers tools DYNAMICALLY at session_start (names come
// from each MCP server's listTools()), so its default factory captures nothing
// via the capturing stub. Import the REAL registration path (registerServerTools
// — the single site every zai tool is built + where ZAI_GATING is attached) and
// drive it with synthetic MCP tools in zaiRegistrar below so the zai single-name
// effective gates build here (keeping its probes live).
import { registerServerTools } from "@repo/pi-agent-ext-zai-mcp/extensions/zai-mcp.ts";
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
type CorpusGate = ToolGate;

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
 * The gate set the corpus evaluates against, built by the SAME production
 * `buildEffectiveGates` the extension runs at session_start (ticket 13a) over
 * the migrated extensions' owner-declared `gating`. Unlike the former stopgap
 * (which collapsed same-signature owner-declared siblings into one multi-name
 * gate), buildEffectiveGates produces SINGLE-NAME gates: each owner-declared
 * non-core tool becomes its own gate (`names:[def.name]`). Firing semantics are
 * identical — siblings share predicates so they co-fire — but the gate-set
 * SHAPE now matches what production emits end to end, so the corpus validates
 * the REAL effective gates rather than a hand-mirrored reconstruction.
 * `CORPUS_EFF` also exposes `.core` + `.tracked` (core ∪ every gate name) for
 * the coverage analyzer (qa/coverage.ts). Single source of truth for findGate /
 * escapeName / matchIntent / coverage below.
 */
// NOTE (tickets 10 + 11): buildEffectiveGates yields one gate per tool, so
// registrar order no longer affects names[0] (every gate IS names[0]); it still
// fixes CORPUS_GATES ordering (and thus matchIntent's first-match / misroute
// target in l2.ts). workflowDefault precedes subagentDefault so the canonical
// signature-group id stays "workflow" (the id qa/probes.ts + findGate key off).
// The 4 tools share identical keywords-only gating → 4 single-name gates that
// co-fire (subagent's ungated companions subagent_runs/subagents carry no gating
// and are skipped by buildEffectiveGates's `if (!g) continue`).
//
// NOTE (ticket 12): zaiRegistrar is appended LAST. zai-mcp's default factory
// captures nothing (dynamic MCP registration), so zaiRegistrar drives
// registerServerTools directly with synthetic MCP tools for both Phase-1 servers
// → captures zai_web_search_web_search_prime (first) + zai_web_reader_webReader.
// Both carry the same ZAI_GATING → two single-name gates whose canonical id
// (zai_web_search_web_search_prime) matches every qa/probes.ts gate id. (GATES
// is empty after ticket 12, so every gate here is owner-declared end to end.)
const zaiRegistrar = (pi: any) => {
	registerServerTools(
		pi,
		{ client: {}, close: async () => {}, serverName: "web_search" },
		[{ name: "web_search_prime", description: "Z.ai web search prime (MCP)" }],
	);
	registerServerTools(
		pi,
		{ client: {}, close: async () => {}, serverName: "web_reader" },
		[{ name: "webReader", description: "Z.ai web reader (MCP)" }],
	);
};

export const CORPUS_EFF = buildEffectiveGates(
	captureOwnerDeclaredDefs([deployDefault, file2mdDefault, flux2Default, krea2Default, ltxDefault, movieDefault, researchDefault, workflowDefault, subagentDefault, zaiRegistrar, powerToolDefault]) as never,
);
export const CORPUS_GATES: CorpusGate[] = CORPUS_EFF.gates;

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

	// Coverage-gap check. buildEffectiveGates yields SINGLE-NAME gates (each
	// owner-declared non-core tool → its own gate), so a naive per-gate-id filter
	// would flag every un-probed sibling (flux2_help, workflow_control,
	// arxiv_paper, …) as a gap. Sibling tools share an identical gating signature
	// {keywords, requires} → the SAME firing predicate → probing ONE sibling
	// validates the whole signature-group. So GROUP single-name gates by signature
	// and treat a group as covered iff ≥1 sibling name has a must-fire case AND
	// ≥1 sibling name has a must-not-fire case (today every group is mono-probed
	// at its canonical names[0], so coverageGaps stays [] for the probed groups).
	const mfHas = new Set(MUST_FIRE.map((p) => p.gate));
	const mnfHas = new Set(MUST_NOT_FIRE.map((p) => p.gate));
	const sigOf = (g: CorpusGate) => JSON.stringify({ keywords: g.keywords, requires: g.requires });
	const groupHasMf = new Map<string, boolean>();
	const groupHasMnf = new Map<string, boolean>();
	const groupRep = new Map<string, string>(); // sig → canonical names[0] (first gate seen)
	for (const g of CORPUS_GATES) {
		const sig = sigOf(g);
		if (!groupRep.has(sig)) groupRep.set(sig, g.names[0]);
		if (mfHas.has(g.names[0])) groupHasMf.set(sig, true);
		if (mnfHas.has(g.names[0])) groupHasMnf.set(sig, true);
	}
	const coverageGaps: string[] = [];
	for (const [sig, id] of groupRep) {
		if (!groupHasMf.get(sig) || !groupHasMnf.get(sig)) coverageGaps.push(id);
	}

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
