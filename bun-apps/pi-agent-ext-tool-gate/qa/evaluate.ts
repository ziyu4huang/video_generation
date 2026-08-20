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
import toolGateDefault, { gateFires, matchIntent, buildEffectiveGates, injectBuiltinCore, BUILTIN_CORE, type ToolGate } from "../extensions/tool-gate.ts";
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
// tickets 03 + 05 (wired): devops registers merge_pr_after_local_ci + sweep_merged_branches
// (both keyword-gated) and show_pr_status (an ungated companion — skipped by
// buildEffectiveGates's `if (!g) continue`). wayfind registers wayfind_effort
// (gating:{ core:true } → routed to the core set, not a gate). Driving both
// default factories against the capturing stub promotes these owner-declared
// tools into CORPUS_EFF so the --strict ungated count drops to 0. NOTE: devops
// ALSO registers deploy_pi_agent_sh + verify_pi_agent_deploy (absorbed from the former pi-agent-ext-
// deploy extension) — both carry owner-declared gating, so they ride via
// devopsDefault here (no separate deploy capture).
import devopsDefault from "@repo/pi-agent-ext-devops/extensions/devops.ts";
import wayfindDefault from "@repo/pi-agent-ext-wayfind/extensions/wayfind.ts";
// ticket 12 — zai-mcp registers tools DYNAMICALLY at session_start (names come
// from each MCP server's listTools()), so its default factory captures nothing
// via the capturing stub. Import the REAL registration path (registerServerTools
// — the single site every zai tool is built + where ZAI_GATING is attached) and
// drive it with synthetic MCP tools in zaiRegistrar below so the zai single-name
// effective gates build here (keeping its probes live).
import { registerServerTools } from "@repo/pi-agent-ext-zai-mcp/extensions/zai-mcp.ts";
// ticket 02 — the 14 in-repo CORE_TOOLS members across 4 packages, owner-declared
// core so buildEffectiveGates routes them to the `core` set authoritatively
// (marking them handled → they stop relying on the CORE_TOOLS fallback).
// knowledge-card / web-access / obsidian register synchronously via their default
// factories, so the capturing stub drives them directly. hermes-memory's default
// factory is async + heavy (backend bundle creation before any registerTool), so
// hermesMemoryRegistrar below invokes its 5 individual registrars with stub args
// (store/repo are deref'd only inside `execute`, which capture never calls).
import knowledgeCardDefault from "@repo/pi-agent-ext-knowledge-card/extensions/knowledge-card.ts";
import webAccessDefault from "@repo/pi-agent-ext-web-access";
import obsidianDefault from "@repo/pi-agent-ext-obsidian/extensions/obsidian.ts";
import { registerMemoryTool } from "@repo/pi-agent-ext-hermes-memory/src/tools/memory-tool.ts";
import { registerSearchTool } from "@repo/pi-agent-ext-hermes-memory/src/tools/search-tool.ts";
import { registerSkillTool } from "@repo/pi-agent-ext-hermes-memory/src/tools/skill-tool.ts";
import { registerKnowledgeSearchTool } from "@repo/pi-agent-ext-hermes-memory/src/tools/knowledge-search-tool.ts";
import { registerKnowledgeIngestTool } from "@repo/pi-agent-ext-hermes-memory/src/tools/knowledge-ingest-tool.ts";
import { createPresentTool } from "@repo/pi-agent-ext-webui/src/present-tool.ts";
// ticket 04 — ext-task's 3 core tools (todo / goal_complete / ask_user_question)
// are owner-declared core. ext-task's default factory is synchronous but HEAVY
// (globalThis pollution, overlays, registerLoop, statusWidget setup) — like
// hermes-memory it can't be driven cleanly by the capturing stub, so drive its
// 3 individual registrars instead (mirrors hermesMemoryRegistrar; proven safe
// by pi-agent-ext-task/src/__tests__/core-gating.test.ts).
import { registerAskUserQuestionTool } from "@repo/pi-agent-ext-task/src/ask-user/ask-user-question.ts";
import { registerTodoTool } from "@repo/pi-agent-ext-task/src/todo/todo.ts";
import goalDefault from "@repo/pi-agent-ext-task/src/goal/goal.ts";
// ticket 04 — tool-gate's own enable_tool is owner-declared core (gating:{ core:true }),
// registered synchronously at the top of its default factory. Driving the factory
// against the capturing stub captures enable_tool (its session_start/before_*
// handlers are no-op'd by the stub; enable_tool's registerTool fires first).
// (toolGateDefault imported above alongside the named exports.)
import {
	MUST_FIRE as AUTHORED_MUST_FIRE,
	MUST_NOT_FIRE as AUTHORED_MUST_NOT_FIRE,
	ESCAPE_NAME,
	ESCAPE_INTENT,
	ESCAPE_INTENT_BLIND,
	PRECISION_RISKS,
	OVERLAPS,
} from "./probes.ts";
import { ALL_PROBE_SETS, deriveL1Cases } from "./collect-probes.ts";

// L1 cases come from two sources that are deliberately NOT merged upstream:
// `probes.ts` holds the corpus authored here (gates whose owning package
// predates the __GATE_PROBES__ seam), while each gated extension owns its own
// cases and exports them from its entry file. Deriving rather than mirroring is
// what lets a package ship a gated tool without editing tool-gate — the failure
// mode that left main red on 2026-08-16.
const DERIVED = deriveL1Cases(ALL_PROBE_SETS);
const MUST_FIRE = [...AUTHORED_MUST_FIRE, ...DERIVED.mustFire];
const MUST_NOT_FIRE = [...AUTHORED_MUST_NOT_FIRE, ...DERIVED.mustNotFire];

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
// The 5 tools share identical keywords-only gating → 5 single-name gates that
// co-fire (subagent's companion subagent_runs carries no gating and is skipped
// by buildEffectiveGates's `if (!g) continue`; subagents (plural) now carries
// the same workflow-family gating and is one of the 5 tracked co-firing gates).
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

// tickets 03+08 — hermes-memory's default factory is async + does heavy backend
// (sqlite/surreal bundle) setup BEFORE registering tools, so the capturing stub
// can't drive it (registration happens after the first await). Invoke the live
// registrars with stub args (store/repo are deref'd only inside `execute`, which
// capture never calls) so the 3 owner-declared-core tools (memory / search /
// skill_manage) build here. registerSkillTool ALSO registers skill_manage_help
// (an ungated companion, NOT a CORE_TOOLS member) — buildEffectiveGates skips
// it via `if (!g) continue`. knowledge_search + knowledge_ingest (keyword-
// gated, NOT core) are captured so their gates stay live in the corpus.
// grill_decision / planning_stale / memory_supersede registrars were REMOVED
// (hermes ticket 03 — the tools no longer exist on the 6-tool surface).
const hermesMemoryRegistrar = (pi: any) => {
	registerMemoryTool(pi, {} as any, null, null, "");
	registerSearchTool(pi, {} as any, {} as any, { variant: "legacy" });
	registerSkillTool(pi, {} as any);
	registerKnowledgeIngestTool(pi, {});
	registerKnowledgeSearchTool(pi, () => "/tmp");
};

// ticket 04 — ext-task's default factory is heavy (see import note); drive the
// 3 owner-declared-core registrars directly so todo / goal_complete /
// ask_user_question land in CORPUS_EFF.core. goal's overlay arg defaults to
// `new GoalOverlay()`, so it's safe to call with just pi.
const coreTaskRegistrar = (pi: any) => {
	registerAskUserQuestionTool(pi);
	registerTodoTool(pi);
	goalDefault(pi);
};

// ticket 04 — the offline corpus must mirror the runtime 20-core. The 20 =
// 16 owner-declared core tools captured from the registrars above (hermes-memory
// ×3 — memory/search/skill_manage, knowledge-card ×4, web-access ×3, obsidian ×2,
// ext-task ×3, tool-gate's enable_tool ×1) PLUS the 4 pi-coding-agent built-ins
// (read/write/edit/bash). The built-ins are NOT registered by any extension here
// (they're harness built-ins), so injectBuiltinCore alone wouldn't add them —
// synthesize the 4 as bare defs and let injectBuiltinCore attach gating:{core:true}
// (the same transformation getDiscovered() runs at runtime), then
// buildEffectiveGates routes all 21 (16 + webui_present + 4 built-ins) into core.
const builtinCoreDefs = () => [...BUILTIN_CORE].map((name) => ({ name }));

// ticket 03 — webui_present (owner-declared core:true, always-on HITL bridge).
// webui's real `wireWebui` boots a WebServer + event handlers — NOT corpus-safe.
// Capture the TOOL DEF directly by constructing createPresentTool with no-op
// deps (execute never runs under capture), mirroring how zai-mcp's registrar
// drives the real registration path. This routes webui_present into
// CORPUS_EFF.core so qa:coverage sees it tracked (not "ungated heavy").
const webuiPresentRegistrar = (pi: any) => {
	pi.registerTool(
		createPresentTool({
			present: () => "",
			registerPending: () => Promise.resolve({ cancelled: true }),
			hasPending: () => false,
			cancelPending: () => false,
			detach: () => {},
		}),
	);
};

export const CORPUS_EFF = buildEffectiveGates(
	injectBuiltinCore([
		...captureOwnerDeclaredDefs([coreTaskRegistrar, toolGateDefault, file2mdDefault, flux2Default, krea2Default, ltxDefault, movieDefault, researchDefault, workflowDefault, subagentDefault, devopsDefault, wayfindDefault, zaiRegistrar, powerToolDefault, knowledgeCardDefault, webAccessDefault, obsidianDefault, hermesMemoryRegistrar, webuiPresentRegistrar]),
		...builtinCoreDefs(),
	] as never),
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
