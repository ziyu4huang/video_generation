/**
 * migrated-extensions — the enumeration substrate shared by tool-gate's gating
 * guards.
 *
 * Holds the MIGRATED_EXTENSIONS source of truth plus the capturing-`pi` helper
 * that turns an extension's registrar into the exact tool defs a live session
 * would see. Lives in a NON-test module on purpose: importing a `.test.ts` from
 * another `.test.ts` re-executes the imported file's suites inside the importer
 * (measured: drift-guard's 26 tests ran twice), so any second guard that needs
 * this enumeration must import it from here.
 *
 * Consumers: drift-guard.test.ts (per-tool valid-gating net) and
 * gating-siblings.test.ts (sibling-group fingerprint drift guard).
 *
 * NOTE: this is test SUPPORT, not a runtime export — it is NOT a registered pi
 * extension (this package's one registered extension is extensions/tool-gate.ts).
 */
import powerTool from "@repo/pi-agent-ext-power-tool";
import { registerAskUserQuestionTool } from "@repo/pi-agent-ext-task/src/ask-user/ask-user-question.ts";
import { registerTodoTool } from "@repo/pi-agent-ext-task/src/todo/todo.ts";
import goalDefault from "@repo/pi-agent-ext-task/src/goal/goal.ts";
import file2mdExtension from "@repo/pi-agent-ext-file2md/extensions/file2md.ts";
import flux2Extension from "@repo/pi-agent-ext-flux2/extensions/flux2.ts";
import krea2Extension from "@repo/pi-agent-ext-krea2/extensions/krea2.ts";
import ltxExtension from "@repo/pi-agent-ext-ltx/extensions/ltx.ts";
import movieExtension from "@repo/pi-agent-ext-movie-director/extensions/movie-director.ts";
import researchExtension from "@repo/pi-agent-ext-research-tool/extensions/research-tool.ts";
import subagentExtension from "@repo/pi-agent-ext-subagent/extensions/subagent.ts";
import workflowExtension from "@repo/pi-agent-ext-workflow/extensions/workflow.ts";
// ticket 12 — zai-mcp registers tools DYNAMICALLY at session_start (names come
// from each MCP server's listTools()), so its default factory registers NOTHING
// at load. Import the REAL registration path (registerServerTools — the single
// site every zai tool is built + where ZAI_GATING is attached) to exercise it
// with synthetic MCP tools in the entry below.
import { registerServerTools } from "@repo/pi-agent-ext-zai-mcp/extensions/zai-mcp.ts";
// ticket 02 — the 4 in-repo CORE_TOOLS packages. knowledge-card / web-access /
// obsidian register synchronously via their default factories. hermes-memory's
// default factory is async + heavy (backend setup before registerTool), so its
// entry below invokes the 5 individual registrars with stub args (store/repo are
// deref'd only inside `execute`, which capture never calls) — mirroring how
// ext-task's entry invokes registerAskUserQuestionTool/registerTodoTool directly.
import knowledgeCardExtension from "@repo/pi-agent-ext-knowledge-card/extensions/knowledge-card.ts";
import webAccessExtension from "@repo/pi-agent-ext-web-access";
import obsidianExtension from "@repo/pi-agent-ext-obsidian/extensions/obsidian.ts";
import { registerMemoryTool } from "@repo/pi-agent-ext-hermes-memory/src/tools/memory-tool.ts";
import { registerSearchTool } from "@repo/pi-agent-ext-hermes-memory/src/tools/search-tool.ts";
import { registerSkillTool } from "@repo/pi-agent-ext-hermes-memory/src/tools/skill-tool.ts";
import { createPresentTool } from "@repo/pi-agent-ext-webui/src/present-tool.ts";
import toolGate from "./tool-gate.ts";

/** A registered tool def — only the fields the guard reads are typed. */
export type ToolDef = {
	name?: string;
	gating?: {
		core?: boolean;
		/** Reference form (wayfinder ticket 01): id into the shared GATE_DEFS registry. */
		gate?: string;
	};
};

/**
 * The migrated-extensions set — the SINGLE source of truth for the rollout
 * regression net. Each entry is a migrated extension plus the way to capture
 * the tool defs it registers. Appending an entry here auto-includes that
 * extension's tools in the net (every tool validated for non-dead owner-declared
 * gating). Rollout tickets 03–12 append their extension here as they migrate.
 *
 * WHY a per-extension entry (not a flat tool-name list): a tool's gating is
 * OWNED by its extension, so the extension's registrar is the authoritative way
 * to capture its real defs (the SAME set a live session sees via registerTool).
 * A flat tool-name list would (a) duplicate ownership and drift from the real
 * registration, and (b) silently miss a NEW tool the extension later registers
 * — the per-extension entry catches a new ungated tool automatically, which is
 * exactly the regression this net exists to catch.
 */
export interface MigratedExtension {
	/** Human id for diagnostics / test names. */
	name: string;
	/** Run the extension's tool registration against the capturing `pi`. */
	register: (pi: any) => void;
	/** Tool names this extension intentionally leaves UNGATED (always-active via
	 *  fail-open) — NOT part of any keyword gate and NOT `gating:{core:true}`.
	 *  The net validates every OTHER registered tool (the gated ones) and asserts
	 *  each `ungatedByDesign` name is ACTUALLY registered (so a typo can't
	 *  silently skip a real tool). Use sparingly: the net's purpose is to catch
	 *  forgotten gating; this is the documented, audited escape hatch for a
	 *  companion tool that is always-on by design and is OUT of its extension's
	 *  migration scope (gating it would newly dorman it = a behavior change).
	 *  Example: pi-agent-ext-subagent owns `spawn_subagent` (renamed from
	 *  `subagent` 2026-08-20; gated by the shared workflow-family gating, ticket
	 *  10) PLUS `list_subagent_runs` (renamed from `subagent_runs` same date),
	 *  which declares no
	 *  gating at all — it was ungated BEFORE this migration and stays ungated to
	 *  preserve behavior (tracked as a known always-on leak). */
	ungatedByDesign?: string[];
}

export const MIGRATED_EXTENSIONS: MigratedExtension[] = [
	{
		name: "power-tool",
		register: (pi) => {
			powerTool(pi);
		},
	},
	{
		name: "task",
		register: (pi) => {
			registerAskUserQuestionTool(pi);
			registerTodoTool(pi);
			goalDefault(pi);
		},
	},
	{
		name: "tool-gate",
		register: (pi) => {
			toolGate(pi);
		},
	},
	{
		name: "file2md",
		register: (pi) => {
			file2mdExtension(pi);
		},
	},
	{
		name: "flux2",
		register: (pi) => {
			flux2Extension(pi);
		},
	},
	{
		name: "krea2",
		register: (pi) => {
			krea2Extension(pi);
		},
	},
	{
		name: "ltx",
		register: (pi) => {
			ltxExtension(pi);
		},
	},
	{
		name: "movie-director",
		register: (pi) => {
			movieExtension(pi);
		},
	},
	{
		name: "research-tool",
		register: (pi) => {
			researchExtension(pi);
		},
	},
	{
		// ticket 11 — workflow/workflow_help/workflow_control (the 3 workflow
		// names in the combined workflow/subagent gate). All 3 are gated; the
		// workflow registrar registers ONLY these 3 tools, so no exemption is
		// needed (unlike subagent, which owns ungated companions).
		name: "workflow",
		register: (pi) => {
			workflowExtension(pi);
		},
	},
	{
		// ticket 10 — `spawn_subagent` (renamed from `subagent` 2026-08-20), plus
		// `list_subagents` (renamed from `subagents`), which has SINCE been
		// given the workflow family's gating (subagents-tool.ts) and is therefore
		// validated by the net like any other gated tool. It was exempted here
		// while it was still always-on; that exemption was stale and was removed
		// 2026-08-10 (it was suppressing validation of a tool that IS gated).
		// `subagent_runs` genuinely declares no gating and stays exempt — the typo
		// guard in runDriftGuardNet fails loudly if it is ever renamed or removed.
		// (Renamed to `list_subagent_runs` 2026-08-20 — docs/agents/extension-naming.md.)
		name: "subagent",
		ungatedByDesign: ["list_subagent_runs"],
		register: (pi) => {
			subagentExtension(pi);
		},
	},
	{
		// ticket 12 — zai-mcp. UNLIKE every other migrated extension, zai-mcp
		// registers its tools DYNAMICALLY at session_start (tool names are
		// discovered from each MCP server's listTools()), so calling its default
		// factory captures NOTHING via registerTool. Exercise the REAL
		// registration path — registerServerTools (the single site every zai tool
		// is built, and where ZAI_GATING is attached) — with synthetic MCP tools
		// for both Phase-1 servers. This proves every dynamically-registered zai
		// tool carries valid owner-declared gating, and produces the exact former
		// GATES names (zai_web_search_web_search_prime + zai_web_reader_webReader).
		// Both declare the same gating, so they share a fingerprint and
		// gatesWithSameGating treats them as ONE co-firing family — buildEffectiveGates
		// itself emits one single-name gate per tool; nothing collapses them into a
		// multi-name gate. The synthetic `managed` (client/close/serverName) is only
		// consumed inside `execute`, which capture never invokes.
		name: "zai-mcp",
		register: (pi) => {
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
		},
	},
	{
		// ticket 02 — knowledge-card. The default factory registers all 4 tools
		// (zk_card / zk_ask / zk_ingest / knowledge_query) synchronously, each now
		// carrying gating:{core:true}.
		name: "knowledge-card",
		register: (pi) => {
			knowledgeCardExtension(pi);
		},
	},
	{
		// ticket 02 — web-access. The default factory registers web_search /
		// fetch_content / get_search_content synchronously, each now core.
		name: "web-access",
		register: (pi) => {
			webAccessExtension(pi);
		},
	},
	{
		// ticket 02 — obsidian. The default factory registers only the 2 fat tools
		// (obsidian / obsidian_help) to pi — the per-action sub-tools are captured
		// into an internal `_capture` map (NOT registered with pi), so the net sees
		// exactly the 2 owner-declared-core tools.
		name: "obsidian",
		register: (pi) => {
			obsidianExtension(pi);
		},
	},
	{
		// ticket 03+08 — hermes surface is 6 tools: memory / search_memory
		// (renamed from `search` 2026-08-20, see docs/agents/extension-naming.md) /
		// skill_manage (owner-declared core) + skill_manage_help (registered by
		// registerSkillTool, ungated always-on companion) + knowledge_search /
		// knowledge_ingest (keyword-gated; captured in qa/evaluate.ts's corpus).
		// grill_decision / planning_stale / memory_supersede registrars were
		// removed (ticket 03): the tools no longer exist on the surface.
		name: "hermes-memory",
		ungatedByDesign: ["skill_manage_help"],
		register: (pi) => {
			registerMemoryTool(pi, {} as any, null, null, null, null);
			registerSearchTool(pi, {} as any, {} as any, { variant: "legacy" });
			registerSkillTool(pi, {} as any);
		},
	},
	{
		// ticket 03 — webui. The real wireWebui boots a WebServer + event handlers
		// (NOT capture-safe), so register the ONE tool def (webui_present,
		// owner-declared core:true — always-on HITL bridge) directly via its
		// exported factory with no-op deps, mirroring zai-mcp's direct-registration
		// entry. execute() never runs under capture.
		name: "webui",
		register: (pi) => {
			pi.registerTool(
				createPresentTool({
					present: () => "",
					registerPending: () => Promise.resolve({ cancelled: true }),
					hasPending: () => false,
					cancelPending: () => false,
				}),
			);
		},
	},
];

/**
 * Capture every tool def an extension registers, by running its setup against a
 * stub `pi`. The stub is a Proxy whose `registerTool` captures defs; `on`
 * swallows lifecycle handlers (tools are registered eagerly at load); all
 * other accesses (getAllTools, events.emit, registerCommand, …) are no-ops so
 * a factory that pokes ancillary API surface never throws. `events` is a
 * nested no-op Proxy so `pi.events.emit(...)` (if probed) resolves harmlessly.
 */
// `pi` is typed `any` (matching the repo's existing stub-pi test convention —
// see ext-task src/__tests__/core-gating.test.ts and tool-gate.test.ts setupPi):
// a real ExtensionAPI has dozens of methods; we only need registerTool capture
// + no-op everything else. `bun test` is this package's gate (no typecheck
// script), and `any` avoids TS2345 friction at each registrar call site.
export function captureRegisteredTools(run: (pi: any) => void): ToolDef[] {
	const captured: ToolDef[] = [];
	const noop = (): undefined => undefined;
	const eventsStub = new Proxy({} as Record<string, unknown>, { get: () => noop });
	const pi = new Proxy({} as Record<string, unknown>, {
		get(_t, prop) {
			if (prop === "registerTool")
				return (def: ToolDef) => {
					captured.push(def);
					return def;
				};
			if (prop === "on") return () => noop; // (event, handler) -> unsubscribe (unused)
			if (prop === "getAllTools") return () => [];
			if (prop === "getAllToolDefinitions") return () => [];
			if (prop === "events") return eventsStub;
			return noop;
		},
	}) as any;
	run(pi);
	return captured;
}
