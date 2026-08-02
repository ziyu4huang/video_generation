/**
 * Drift-guard — the rollout regression net.
 *
 * Every tool OWNED by a MIGRATED extension must declare valid (non-dead)
 * owner-`gating`. The set of migrated extensions is the single source of truth
 * below (MIGRATED_EXTENSIONS); the net iterates it, so APPENDING an entry is
 * all a rollout ticket does to put that extension's tools behind this gate.
 *
 * WHY: the `Gating.keywords` field was relaxed to OPTIONAL in Task 2 (so a
 * `gating:{core:true}` declaration typechecks — a core tool legitimately has no
 * keywords). That relaxation removed the compile-time guard against a tool
 * shipping with NO gating at all (or a DEAD gate). This test is the runtime
 * backstop: it enumerates each migrated extension's registered tools and
 * strict-fails if any lacks a valid `gating`.
 *
 * SCOPE (today): the 3 migration pilots + deploy (ticket 03) + file2md
 * (ticket 04) — power-tool (6 inspect_*), core-task (ask_user_question /
 * todo / goal_complete), tool-gate (enable_tool), deploy (pi_deploy /
 * pi_verify), file2md (file2md / vision_ask). The other ~7 unmigrated
 * extensions are NOT asserted here; rollout tickets 05–12
 * APPEND their extension to MIGRATED_EXTENSIONS as they migrate, which
 * auto-includes that extension's tools here. Built-ins (read/write/edit/bash/
 * grep/find/ls) are NOT registered by these extensions, so they are naturally
 * exempt — no allowlist needed.
 *
 * WHAT "valid gating" means (validateGating below):
 *   1. non-null `gating` (missing = declaration bug = fail), AND
 *   2. DEAD-GATE check: if `gating.core !== true`, the gate must be ABLE to
 *      fire for SOME prompt — i.e. carry a non-empty `keywords` array OR a
 *      `requires` co-occurrence with ≥1 noun AND ≥1 verb (mirroring `gateFires`,
 *      which fires on a keyword match OR a noun∧verb co-occurrence). A non-core
 *      gate with no keywords and no fireable requires can NEVER fire = dead gate
 *      = declaration bug = fail. This includes the empty-requires cases
 *      (`requires:{}`, `{nouns:[],verbs:[]}`, noun-only, verb-only) — FOLLOWUPS
 *      #8: the prior check treated ANY non-null object as "has requires",
 *      letting `requires:{}` slip through as non-dead.
 *
 * Enumeration: each migrated extension is invoked with a capturing stub `pi`
 * whose `registerTool` pushes the def into an array — the SAME set of defs a
 * real session would see. power-tool's default factory registers all 6
 * inspect_* (two of the factories — hooks/pathology — are not individually
 * exported, so the default factory is the only way to capture the full set);
 * core-task's 3 registrars are invoked directly (its full extension factory has
 * heavy overlay/widget/globalThis side effects unrelated to tool registration);
 * tool-gate's default factory registers enable_tool.
 */
import { describe, expect, test } from "bun:test";
import powerTool from "@repo/pi-agent-ext-power-tool";
import { registerAskUserQuestionTool } from "@repo/pi-agent-ext-core-task/src/ask-user/ask-user-question.ts";
import { registerTodoTool } from "@repo/pi-agent-ext-core-task/src/todo/todo.ts";
import goalDefault from "@repo/pi-agent-ext-core-task/src/goal/goal.ts";
import deployExtension from "@repo/pi-agent-ext-deploy";
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
import toolGate from "./tool-gate.ts";

/** A registered tool def — only the fields the guard reads are typed. */
type ToolDef = {
	name?: string;
	gating?: { core?: boolean; keywords?: string[]; requires?: { nouns?: unknown[]; verbs?: unknown[] } };
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
	 *  Example: pi-agent-ext-subagent owns `subagent` (gated by the combined
	 *  workflow/subagent gate, ticket 10) PLUS `subagent_runs` + `subagents`
	 *  (plural), which were ungated BEFORE this migration and stay ungated to
	 *  preserve behavior (tracked as known always-on leaks). */
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
		name: "core-task",
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
		name: "deploy",
		register: (pi) => {
			deployExtension(pi);
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
		// ticket 10 — `subagent` (the 1 subagent name in the combined
		// workflow/subagent gate). This extension ALSO owns `subagent_runs` +
		// `subagents` (plural), which were UNGATED (always-active via fail-open)
		// BEFORE this migration and stay ungated to preserve behavior (gating
		// them would newly dorman them = a behavior change out of scope; the
		// combined GATES entry only ever covered `subagent`). They are listed
		// ungatedByDesign so the net validates `subagent` (the gated one) without
		// false-flagging the intentionally-always-on companions — and the typo
		// guard above fails loudly if either companion is ever renamed/removed.
		name: "subagent",
		ungatedByDesign: ["subagent_runs", "subagents"],
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
		// GATES names (zai_web_search_web_search_prime + zai_web_reader_webReader)
		// so reconstructOwnerDeclaredGates collapses them back into the original
		// 2-name gate. The synthetic `managed` (client/close/serverName) is only
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
// see core-task src/__tests__/core-gating.test.ts and tool-gate.test.ts setupPi):
// a real ExtensionAPI has dozens of methods; we only need registerTool capture
// + no-op everything else. `bun test` is this package's gate (no typecheck
// script), and `any` avoids TS2345 friction at each registrar call site.
function captureRegisteredTools(run: (pi: any) => void): ToolDef[] {
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

/**
 * Pure gating validator — the heart of the drift-guard. Throws on:
 *   - missing/null `gating` (declaration bug), or
 *   - a DEAD GATE: non-core gating with no keywords and no fireable requires
 *     (can never fire = declaration bug). Factored out so the NEGATIVE cases
 *     can assert it throws via expect().toThrow.
 */
export function validateGating(def: ToolDef): void {
	if (!def || typeof def !== "object") throw new Error("invalid tool def");
	const name = def.name ?? "<anonymous>";
	if (def.gating == null) throw new Error(`'${name}' is missing owner-declared gating`);
	const g = def.gating;
	if (g.core === true) return; // core/escape-hatch — exempt from the dead-gate check
	// DEAD-GATE check (mirrors gateFires): a non-core gate can fire iff it has
	// ≥1 keyword OR a requires with ≥1 noun AND ≥1 verb. Anything else can NEVER
	// fire = dead gate = declaration bug. FOLLOWUPS #8: the prior check treated
	// ANY non-null object as "has requires", letting `requires:{}` (and noun-only /
	// verb-only) slip through as non-dead.
	const hasKeywords = Array.isArray(g.keywords) && g.keywords.length > 0;
	const req = g.requires;
	const hasNoun = Array.isArray(req?.nouns) && req.nouns.length > 0;
	const hasVerb = Array.isArray(req?.verbs) && req.verbs.length > 0;
	const canFireRequires = hasNoun && hasVerb;
	if (!hasKeywords && !canFireRequires) {
		throw new Error(
			`'${name}' is a DEAD GATE: non-core gating with no keywords and no ` +
				`fireable requires (needs ≥1 noun AND ≥1 verb) can never fire ` +
				`(tool-gate gateFires only matches keywords/requires)`,
		);
	}
}

/** Assert every def in `defs` carries valid gating (throws on the first offender). */
function assertAllValid(defs: ToolDef[]): void {
	expect(defs.length, "capture must be non-empty (else the guard passes vacuously)").toBeGreaterThan(0);
	for (const def of defs) validateGating(def);
}

/**
 * The net: capture every tool def registered by every migrated extension and
 * validate them all. This is the rollout regression gate — appending a
 * MIGRATED_EXTENSIONS entry is all a rollout ticket does to put its tools here.
 */
export function runDriftGuardNet(extensions: MigratedExtension[]): void {
	for (const ext of extensions) {
		let defs = captureRegisteredTools(ext.register);
		const exempt = new Set(ext.ungatedByDesign ?? []);
		if (exempt.size > 0) {
			// Typo guard: every `ungatedByDesign` name must ACTUALLY be registered,
			// else a typo would silently skip a real tool (or hide a removed one).
			const registered = new Set(defs.map((d) => d.name));
			for (const ex of exempt) {
				if (!registered.has(ex))
					throw new Error(
						`'${ext.name}' lists '${ex}' in ungatedByDesign but does not register it ` +
							`(typo, or the tool was removed — drop it from ungatedByDesign)`,
				);
			}
			defs = defs.filter((d) => !exempt.has(d.name));
		}
		assertAllValid(defs);
	}
}

/** Look up a migrated extension by name (single-source: per-pilot tests capture
 *  via the entry, so removing an entry breaks its characterization test). */
function entry(name: string): MigratedExtension {
	const e = MIGRATED_EXTENSIONS.find((m) => m.name === name);
	if (!e) throw new Error(`no migrated extension named '${name}' in MIGRATED_EXTENSIONS`);
	return e;
}

// ────────────────────────────────────────────────────────────────────
// Per-pilot characterization tests (preserve exact pilot coverage: names +
// core/non-core intent). Each captures via its MIGRATED_EXTENSIONS entry so the
// source of truth stays single.
// ────────────────────────────────────────────────────────────────────
describe("drift-guard — pilot tools declare valid gating", () => {
	test("power-tool: all 6 inspect_* carry valid (non-dead) gating", () => {
		const defs = captureRegisteredTools(entry("power-tool").register);
		// Non-vacuous: assert the expected names are present (capture captured the
		// real tools, not an empty set).
		const names = defs.map((d) => d.name).sort();
		expect(names).toEqual(
			[
				"inspect_agent",
				"inspect_context",
				"inspect_extensions",
				"inspect_hooks",
				"inspect_pathology",
				"inspect_tui",
			].sort(),
		);
		assertAllValid(defs);
		// The inspect_* group is non-core — prove the DEAD-GATE branch is exercised
		// (each has keywords AND requires, so none is dead).
		for (const d of defs) {
			expect(d.gating?.core, `'${d.name}' is intentionally non-core (keyword-gated)`).not.toBe(true);
			expect(d.gating?.keywords?.length, `'${d.name}' has non-empty keywords`).toBeGreaterThan(0);
		}
	});

	test("core-task: ask_user_question / todo / goal_complete carry gating:{core:true}", () => {
		const defs = captureRegisteredTools(entry("core-task").register);
		const names = defs.map((d) => d.name).sort();
		expect(names).toEqual(["ask_user_question", "goal_complete", "todo"].sort());
		assertAllValid(defs);
		// core tools: core === true (exempt from dead-gate; legitimately keyword-less)
		for (const d of defs) expect(d.gating?.core, `'${d.name}' is owner-declared core`).toBe(true);
	});

	test("tool-gate: enable_tool carries gating:{core:true}", () => {
		const defs = captureRegisteredTools(entry("tool-gate").register);
		const enableTool = defs.find((d) => d.name === "enable_tool");
		expect(enableTool, "enable_tool must be registered by tool-gate's factory").toBeDefined();
		// enable_tool is core (always-active escape hatch) — validate it directly.
		validateGating(enableTool!);
		expect(enableTool!.gating?.core).toBe(true);
	});

	test("NEGATIVE: stripping gating from a pilot def makes validateGating throw (guard bites)", () => {
		// Grab a real pilot def so the negative case runs against the actual
		// shape the positive cases assert over (not a hand-rolled stub).
		const defs = captureRegisteredTools(entry("power-tool").register);
		const victim = defs[0];
		expect(victim, "need a captured def to strip").toBeDefined();

		// (a) missing gating entirely → throws
		const stripped = { ...victim } as ToolDef;
		delete stripped.gating;
		expect(() => validateGating(stripped)).toThrow(/missing owner-declared gating/);

		// (b) DEAD GATE: non-core gating with no keywords and no requires → throws.
		// (The carry-forward runtime check that the Task-2 OPTIONAL-keywords
		// relaxation dropped from the type level.)
		const dead = { ...victim, gating: { core: false } } as ToolDef;
		expect(() => validateGating(dead)).toThrow(/DEAD GATE/);

		// (d) DEAD GATE via EMPTY requires (FOLLOWUPS #8): a non-core gate with
		// `requires:{}` (present but noun-less/verb-less) and no keywords can NEVER
		// fire — gateFires needs ≥1 noun AND ≥1 verb — yet the prior check treated
		// ANY non-null object as "has requires" and accepted it. Must throw.
		const deadEmptyRequires = { ...victim, gating: { requires: {} } } as ToolDef;
		expect(() => validateGating(deadEmptyRequires)).toThrow(/DEAD GATE/);

		// (e) DEAD GATE via noun-only requires (FOLLOWUPS #8): a noun without a
		// verb can never satisfy the noun∧verb co-occurrence → dead. Must throw.
		const deadNounOnly = { ...victim, gating: { requires: { nouns: ["thing"] } } } as ToolDef;
		expect(() => validateGating(deadNounOnly)).toThrow(/DEAD GATE/);

		// (c) sanity: the un-stripped victim still validates (so the throw above is
		// due to the gating change, not a pre-existing flaw in the def).
		expect(() => validateGating(victim)).not.toThrow();
	});
});

// ────────────────────────────────────────────────────────────────────
// The rollout regression net — iterates MIGRATED_EXTENSIONS. This is the gate
// every rollout ticket (03–12) must pass before its extension leaves the
// fallback: append the extension to MIGRATED_EXTENSIONS and its tools are
// validated here automatically.
// ────────────────────────────────────────────────────────────────────
describe("drift-guard — rollout regression net (iterates MIGRATED_EXTENSIONS)", () => {
	// One assertion per migrated extension so a failing extension names itself in
	// the test output. Appending a MIGRATED_EXTENSIONS entry is all a rollout
	// ticket does to put its tools behind this net.
	for (const ext of MIGRATED_EXTENSIONS) {
		test(`${ext.name}: every registered tool carries valid (non-dead) gating`, () => {
			runDriftGuardNet([ext]);
		});
	}

	test("aggregate: ALL migrated extensions pass the net together", () => {
		runDriftGuardNet(MIGRATED_EXTENSIONS);
	});

	test("the net auto-includes a placeholder migrated extension's tools (appending surfaces them)", () => {
		// A placeholder entry that registers a VALID gated tool passes the net —
		// proving the net iterates entries beyond the 3 pilots. Rollout tickets
		// append a real entry here and its tools are validated identically.
		const placeholder: MigratedExtension = {
			name: "placeholder-valid",
			register: (pi) => {
				pi.registerTool({ name: "future_gated_tool", gating: { keywords: ["future"] } });
			},
		};
		expect(() => runDriftGuardNet([placeholder])).not.toThrow();
	});

	test("NEGATIVE: a migrated tool with NO gating fails the net (regression bites)", () => {
		// A migrated extension that registers a tool WITHOUT gating must fail the
		// net — this is the core regression the net exists to catch (a rollout
		// that ships an ungated tool is blocked here, not in production).
		const placeholder: MigratedExtension = {
			name: "placeholder-missing-gating",
			register: (pi) => {
				pi.registerTool({ name: "future_ungated_tool" });
			},
		};
		expect(() => runDriftGuardNet([placeholder])).toThrow(/missing owner-declared gating/);
	});

	test("NEGATIVE: a migrated tool with a DEAD gate (empty requires + no keywords) fails the net", () => {
		// FOLLOWUPS #8: a non-core gate with `requires:{}` + no keywords is dead
		// (gateFires needs ≥1 noun ∧ ≥1 verb); the net must reject it. The prior
		// check accepted ANY non-null object as "has requires" — this proves the
		// tightened net bites on the empty-requires case.
		const placeholder: MigratedExtension = {
			name: "placeholder-dead-gate",
			register: (pi) => {
				pi.registerTool({ name: "future_dead_tool", gating: { requires: {} } });
			},
		};
		expect(() => runDriftGuardNet([placeholder])).toThrow(/DEAD GATE/);
	});

	test("ungatedByDesign: an extension with an always-on companion (ungated) passes the net", () => {
		// Mirrors subagent's real shape (ticket 10): a gated tool + ungated
		// companions that are always-on by design. The net validates the gated
		// tool and skips the ungatedByDesign names (they're intentionally
		// always-active, out of the gate's scope — gating them would be a
		// behavior change).
		const ext: MigratedExtension = {
			name: "with-companion",
			ungatedByDesign: ["companion_always_on"],
			register: (pi) => {
				pi.registerTool({ name: "gated_tool", gating: { keywords: ["kw"] } });
				pi.registerTool({ name: "companion_always_on" }); // ungated by design
			},
		};
		expect(() => runDriftGuardNet([ext])).not.toThrow();
	});

	test("NEGATIVE: ungatedByDesign typo guard — a listed-but-unregistered name fails", () => {
		// ungatedByDesign must list names the extension ACTUALLY registers, else
		// a typo silently skips a real tool (or hides a removed one). The net
		// fails loudly so the list can't drift.
		const ext: MigratedExtension = {
			name: "typo-exempt",
			ungatedByDesign: ["ghost_tool"],
			register: (pi) => {
				pi.registerTool({ name: "gated_tool", gating: { keywords: ["kw"] } });
			},
		};
		expect(() => runDriftGuardNet([ext])).toThrow(
			/lists 'ghost_tool' in ungatedByDesign but does not register it/,
		);
	});
});
