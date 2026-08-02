/**
 * Drift-guard (scoped) — every tool OWNED by the 3 pilot extensions must
 * declare valid owner-`gating`.
 *
 * WHY: the `Gating.keywords` field was relaxed to OPTIONAL in Task 2 (so a
 * `gating:{core:true}` declaration typechecks — a core tool legitimately has no
 * keywords). That relaxation removed the compile-time guard against a pilot
 * tool shipping with NO gating at all. This test is the runtime backstop: it
 * enumerates each pilot's registered tools and strict-fails if any lacks a
 * valid `gating`.
 *
 * SCOPE: the 3 migration pilots — power-tool (6 inspect_*), core-task
 * (ask_user_question / todo / goal_complete), tool-gate (enable_tool). The
 * other ~9 unmigrated extensions are NOT asserted here (the rollout migrates
 * them later). Built-ins (read/write/edit/bash/grep/find/ls) are NOT
 * registered by pilots, so they are naturally exempt — no allowlist needed.
 *
 * WHAT "valid gating" means (validateGating below):
 *   1. non-null `gating` (missing = declaration bug = fail), AND
 *   2. DEAD-GATE check: if `gating.core !== true`, the gate must carry a
 *      non-empty `keywords` array OR a `requires` co-occurrence block. A
 *      non-core gate with empty keywords AND no requires can NEVER fire
 *      (tool-gate's gateFires only matches keywords/requires) = dead gate =
 *      declaration bug = fail. (Carry-forward of Task-2 review finding A:
 *      the OPTIONAL-keywords relaxation removed the compile-time guard, so the
 *      runtime dead-gate check here is the only thing catching it.)
 *
 * Enumeration: each pilot is invoked with a capturing stub `pi` whose
 * `registerTool` pushes the def into an array — the SAME set of defs a real
 * session would see. power-tool's default factory registers all 6 inspect_*
 * (two of the factories — hooks/pathology — are not individually exported, so
 * the default factory is the only way to capture the full set); core-task's 3
 * registrars are invoked directly (its full extension factory has heavy
 * overlay/widget/globalThis side effects unrelated to tool registration);
 * tool-gate's default factory registers enable_tool.
 */
import { describe, expect, test } from "bun:test";
import powerTool from "@repo/pi-agent-ext-power-tool";
import { registerAskUserQuestionTool } from "@repo/pi-agent-ext-core-task/src/ask-user/ask-user-question.ts";
import { registerTodoTool } from "@repo/pi-agent-ext-core-task/src/todo/todo.ts";
import goalDefault from "@repo/pi-agent-ext-core-task/src/goal/goal.ts";
import toolGate from "./tool-gate.ts";

/** A registered tool def — only the fields the guard reads are typed. */
type ToolDef = { name?: string; gating?: { core?: boolean; keywords?: string[]; requires?: unknown } };

/**
 * Capture every tool def a pilot registers, by running its setup against a
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
 *   - a DEAD GATE: non-core gating with no keywords and no requires (can never
 *     fire = declaration bug). Factored out so the NEGATIVE case can assert it
 *     throws via expect().toThrow.
 */
export function validateGating(def: ToolDef): void {
	if (!def || typeof def !== "object") throw new Error("invalid tool def");
	const name = def.name ?? "<anonymous>";
	if (def.gating == null) throw new Error(`'${name}' is missing owner-declared gating`);
	const g = def.gating;
	if (g.core === true) return; // core/escape-hatch — exempt from the dead-gate check
	const hasKeywords = Array.isArray(g.keywords) && g.keywords.length > 0;
	const hasRequires = g.requires != null && typeof g.requires === "object";
	if (!hasKeywords && !hasRequires) {
		throw new Error(
			`'${name}' is a DEAD GATE: non-core gating with empty keywords and no ` +
				`requires can never fire (tool-gate gateFires only matches keywords/requires)`,
		);
	}
}

/** Assert every def in `defs` carries valid gating (throws on the first offender). */
function assertAllValid(defs: ToolDef[]): void {
	expect(defs.length, "capture must be non-empty (else the guard passes vacuously)").toBeGreaterThan(0);
	for (const def of defs) validateGating(def);
}

describe("drift-guard — pilot tools declare valid gating", () => {
	test("power-tool: all 6 inspect_* carry valid (non-dead) gating", () => {
		const defs = captureRegisteredTools((pi) => {
			powerTool(pi);
		});
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
		const defs = captureRegisteredTools((pi) => {
			registerAskUserQuestionTool(pi);
			registerTodoTool(pi);
			goalDefault(pi);
		});
		const names = defs.map((d) => d.name).sort();
		expect(names).toEqual(["ask_user_question", "goal_complete", "todo"].sort());
		assertAllValid(defs);
		// core tools: core === true (exempt from dead-gate; legitimately keyword-less)
		for (const d of defs) expect(d.gating?.core, `'${d.name}' is owner-declared core`).toBe(true);
	});

	test("tool-gate: enable_tool carries gating:{core:true}", () => {
		const defs = captureRegisteredTools((pi) => {
			toolGate(pi);
		});
		const enableTool = defs.find((d) => d.name === "enable_tool");
		expect(enableTool, "enable_tool must be registered by tool-gate's factory").toBeDefined();
		// enable_tool is core (always-active escape hatch) — validate it directly.
		validateGating(enableTool!);
		expect(enableTool!.gating?.core).toBe(true);
	});

	test("NEGATIVE: stripping gating from a pilot def makes validateGating throw (guard bites)", () => {
		// Grab a real pilot def so the negative case runs against the actual
		// shape the positive cases assert over (not a hand-rolled stub).
		const defs = captureRegisteredTools((pi) => {
			powerTool(pi);
		});
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

		// (c) sanity: the un-stripped victim still validates (so the throw above is
		// due to the gating change, not a pre-existing flaw in the def).
		expect(() => validateGating(victim)).not.toThrow();
	});
});
