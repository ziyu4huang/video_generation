/**
 * Drift-guard — the rollout regression net.
 *
 * Every tool OWNED by a MIGRATED extension must declare valid (non-dead)
 * owner-`gating`. The set of migrated extensions is the single source of truth
 * in ../qa/migrated-extensions.ts (MIGRATED_EXTENSIONS, imported below); the net
 * iterates it, so APPENDING an entry there is all a rollout ticket does to put
 * that extension's tools behind this gate.
 *
 * WHY: the `Gating.keywords` field was relaxed to OPTIONAL in Task 2 (so a
 * `gating:{core:true}` declaration typechecks — a core tool legitimately has no
 * keywords). That relaxation removed the compile-time guard against a tool
 * shipping with NO gating at all (or a DEAD gate). This test is the runtime
 * backstop: it enumerates each migrated extension's registered tools and
 * strict-fails if any lacks a valid `gating`.
 *
 * SCOPE (today): the 3 migration pilots + file2md
 * (ticket 04) — power-tool (6 inspect_*), ext-task (ask_user_question /
 * goal_complete), tool-gate (enable_tool), file2md (file2md /
 * vision_ask). The other ~7 unmigrated extensions are NOT asserted here; rollout tickets 05–12
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
 * ext-task's registrars are invoked directly (its full extension factory has
 * heavy overlay/widget/globalThis side effects unrelated to tool registration);
 * tool-gate's default factory registers enable_tool.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { GATE_DEFS } from "@repo/s2-agent-core-interface";
import {
	MIGRATED_EXTENSIONS,
	captureRegisteredTools,
	type MigratedExtension,
	type ToolDef,
} from "../qa/migrated-extensions.ts";
import { BUILTIN_CORE } from "./tool-gate.ts";
import { TOOLS_PROBE_CORE } from "../../s2-agent-ext-devops/src/tools-active-probe.ts";

/**
 * Pure gating validator — the heart of the drift-guard. Throws on:
 *   - missing/null `gating` (declaration bug), or
 *   - a DEAD GATE: a `gate` reference whose resolved registry spec has no
 *     keywords and no fireable requires (can never fire = declaration bug), or
 *   - an UNKNOWN gate reference: `gating: { gate: "<id>" }` where `<id>` is
 *     absent from the shared `GATE_DEFS` registry (wayfinder ticket 01
 *     reference form — the runtime fails open, the guard fails loudly).
 * Factored out so the NEGATIVE cases can assert it throws via expect().toThrow.
 *
 * Since phase 01c the ONLY non-core form is the reference form: `gating: {
 * gate: "<id>" }`. The inline keywords/requires shape was deleted — a non-core
 * gating WITHOUT a `gate` reference is itself a declaration bug (fails here).
 */
export function validateGating(def: ToolDef): void {
	if (!def || typeof def !== "object") throw new Error("invalid tool def");
	const name = def.name ?? "<anonymous>";
	if (def.gating == null) throw new Error(`'${name}' is missing owner-declared gating`);
	const g = def.gating;
	if (g.core === true) return; // core/escape-hatch — exempt from the dead-gate check
	// Non-core gating MUST be a reference form since 01c (inline form deleted).
	if (g.gate == null) {
		throw new Error(
			`'${name}' has non-core gating without a \`gate\` reference — the inline ` +
				`keywords/requires form was deleted in phase 01c; declare a family in ` +
				`GATE_DEFS and use \`gating: { gate: "<id>" }\``,
		);
	}
	const spec = GATE_DEFS[g.gate];
	if (!spec) {
		throw new Error(
			`'${name}' references unknown gate id '${g.gate}' — declare it in GATE_DEFS ` +
				`(or fix the reference)`,
		);
	}
	// DEAD-GATE check (mirrors gateFires): a non-core gate can fire iff it has
	// ≥1 keyword OR a requires with ≥1 noun AND ≥1 verb. Anything else can NEVER
	// fire = dead gate = declaration bug. FOLLOWUPS #8: the prior check treated
	// ANY non-null object as "has requires", letting `requires:{}` (and noun-only /
	// verb-only) slip through as non-dead.
	const hasKeywords = Array.isArray(spec.keywords) && spec.keywords.length > 0;
	const req = spec.requires;
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

/**
 * The reverse invariant (ticket 01, phase 01c): every gate id DECLARED in the
 * shared GATE_DEFS registry must be REFERENCED by at least one registered tool
 * across the migrated extensions. A declared-but-unreferenced family is dead
 * data (and usually signals a typo'd reference elsewhere). Pure — throws with
 * the orphan list.
 */
export function assertEveryGateReferenced(extensions: MigratedExtension[]): void {
	const referenced = new Set<string>();
	for (const ext of extensions) {
		for (const def of captureRegisteredTools(ext.register)) {
			const gate = def.gating?.gate;
			if (gate != null) referenced.add(gate);
		}
	}
	const orphans = Object.keys(GATE_DEFS).filter((id) => !referenced.has(id)).sort();
	if (orphans.length > 0) {
		throw new Error(
			`GATE_DEFS declares gate id(s) referenced by NO registered tool: ${orphans.join(", ")}. ` +
				`Every declared family must be referenced (a typo'd tool reference would orphan it).`,
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
			defs = defs.filter((d) => d.name == null || !exempt.has(d.name));
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
	test("power-tool: 6 core inspect_* + power_browser-gated browser carry valid (non-dead) gating", () => {
		const defs = captureRegisteredTools(entry("power-tool").register);
		// Non-vacuous: assert the expected names are present (capture captured the
		// real tools, not an empty set). This list is deliberately hand-maintained
		// — it is the tripwire that fires when power-tool grows or loses a tool,
		// which is exactly how `webui` (#1564) was caught (and again when `webui`
		// moved to s2-agent-ext-webui, 2026-08-25 — it audits that package's own
		// server and registers there now; that dynamic ext is not a captured
		// pilot, so its tool is out of this characterization).
		const names = defs.map((d) => d.name).sort();
		expect(names).toEqual(
			[
				"browser",
				"inspect_agent",
				"inspect_context",
				"inspect_extensions",
				"inspect_hooks",
				"inspect_pathology",
				"inspect_tui",
			].sort(),
		);
		assertAllValid(defs);
		// ticket 06 (HITL): the inspect_* group is now owner-declared CORE
		// (always-on diagnostics — the former "inspect" gate family + its
		// keyword predicate were retired; see power-tool src/gating.ts).
		for (const d of defs.filter((x) => x.name?.startsWith("inspect_"))) {
			expect(d.gating?.core, `'${d.name}' is owner-declared core (ticket 06 un-gate)`).toBe(true);
			expect(d.gating?.gate, `'${d.name}' no longer references a gate family`).toBeUndefined();
		}
		// The non-inspect_ tools are the deliberate exception: on-demand headless
		// Chrome (`browser` — and `webui`, which drives the same engine but moved
		// to s2-agent-ext-webui 2026-08-25), so they stay keyword-gated rather
		// than riding along with the always-on
		// diagnostics. Asserting the inverse of the inspect_* rule keeps a future
		// un-gating from passing silently.
		//
		// Written as a loop over "everything that is not inspect_*" rather than a
		// lookup of one hardcoded name: when #1564 added `webui` to this same gate
		// family, a `defs.find(d => d.name === "browser")` assertion said nothing
		// about it. Now any new tool in the group is checked the moment it appears.
		const gated = defs.filter((d) => !d.name?.startsWith("inspect_"));
		expect(gated.map((d) => d.name).sort()).toEqual(["browser"]);
		for (const d of gated) {
			expect(d.gating?.gate, `'${d.name}' is gated, not core`).toBe("power_browser");
			expect(d.gating?.core, `'${d.name}' must not be owner-declared core`).toBeFalsy();
		}
	});

	test("ext-task: ask_user_question / goal_complete carry gating:{core:true}", () => {
		const defs = captureRegisteredTools(entry("task").register);
		const names = defs.map((d) => d.name).sort();
		// `todo` retired with its tool (cc-parity-task-powertool t02/D7); the
		// task family (task_create/get/list/update) is core-gated in ext-subagent.
		expect(names).toEqual(["ask_user_question", "goal_complete"].sort());
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

		// (b) DEAD GATE: a reference whose registry spec has no keywords and no
		// requires → throws. (The carry-forward runtime check that the Task-2
		// OPTIONAL-keywords relaxation dropped from the type level.)
		GATE_DEFS["__dead_spec"] = { id: "__dead_spec" }; // registered but fireless
		const dead = { ...victim, gating: { gate: "__dead_spec" } } as ToolDef;
		expect(() => validateGating(dead)).toThrow(/DEAD GATE/);
		delete GATE_DEFS["__dead_spec"];

		// (c) INLINE FORM DELETED (01c): a non-core gating with inline
		// keywords/requires and NO gate reference is itself a declaration bug.
		const inlineForm = { ...victim, gating: { keywords: ["kw"] } } as ToolDef;
		expect(() => validateGating(inlineForm)).toThrow(/without a `gate` reference/);

		// (d) sanity: the un-stripped victim still validates (so the throw above is
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
		// Reference form (01c): the tool must point at a registered fireable gate.
		GATE_DEFS["__placeholder"] = { id: "__placeholder", keywords: ["future"] };
		const placeholder: MigratedExtension = {
			name: "placeholder-valid",
			register: (pi) => {
				pi.registerTool({ name: "future_gated_tool", gating: { gate: "__placeholder" } });
			},
		};
		expect(() => runDriftGuardNet([placeholder])).not.toThrow();
		delete GATE_DEFS["__placeholder"];
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

	test("NEGATIVE: a migrated tool referencing an UNKNOWN gate id fails the net", () => {
		// 01c: the only non-core form is a gate reference, so an unknown id is the
		// declaration bug the net must reject (runtime fails open; CI fails loud).
		const placeholder: MigratedExtension = {
			name: "placeholder-unknown-gate",
			register: (pi) => {
				pi.registerTool({ name: "future_gated_tool", gating: { gate: "no-such-gate" } });
			},
		};
		expect(() => runDriftGuardNet([placeholder])).toThrow(/references unknown gate id/);
	});

	test("NEGATIVE: a migrated tool with a DEAD gate (reference to a fireless spec) fails the net", () => {
		// FOLLOWUPS #8 carried forward: a family whose spec has no keywords and no
		// fireable requires (e.g. `requires:{}`) can NEVER fire — the net must
		// reject a tool referencing it.
		GATE_DEFS["__dead"] = { id: "__dead" }; // registered but fireless
		const placeholder: MigratedExtension = {
			name: "placeholder-dead-gate",
			register: (pi) => {
				pi.registerTool({ name: "future_dead_tool", gating: { gate: "__dead" } });
			},
		};
		expect(() => runDriftGuardNet([placeholder])).toThrow(/DEAD GATE/);
		delete GATE_DEFS["__dead"];
	});

	test("ungatedByDesign: an extension with an always-on companion (ungated) passes the net", () => {
		// Mirrors subagent's real shape (ticket 10): a gated tool + ungated
		// companions that are always-on by design. The net validates the gated
		// tool and skips the ungatedByDesign names (they're intentionally
		// always-active, out of the gate's scope — gating them would be a
		// behavior change).
		GATE_DEFS["__kw"] = { id: "__kw", keywords: ["kw"] };
		const ext: MigratedExtension = {
			name: "with-companion",
			ungatedByDesign: ["companion_always_on"],
			register: (pi) => {
				pi.registerTool({ name: "gated_tool", gating: { gate: "__kw" } });
				pi.registerTool({ name: "companion_always_on" }); // ungated by design
			},
		};
		expect(() => runDriftGuardNet([ext])).not.toThrow();
		delete GATE_DEFS["__kw"];
	});

	test("NEGATIVE: ungatedByDesign typo guard — a listed-but-unregistered name fails", () => {
		// ungatedByDesign must list names the extension ACTUALLY registers, else
		// a typo silently skips a real tool (or hides a removed one). The net
		// fails loudly so the list can't drift.
		GATE_DEFS["__kw2"] = { id: "__kw2", keywords: ["kw"] };
		const ext: MigratedExtension = {
			name: "typo-exempt",
			ungatedByDesign: ["ghost_tool"],
			register: (pi) => {
				pi.registerTool({ name: "gated_tool", gating: { gate: "__kw2" } });
			},
		};
		expect(() => runDriftGuardNet([ext])).toThrow(
			/lists 'ghost_tool' in ungatedByDesign but does not register it/,
		);
		delete GATE_DEFS["__kw2"];
	});

	test("every declared GATE_DEFS id is referenced by ≥1 registered tool (01c reverse invariant)", () => {
		// The aggregate net must cover the whole registry — a family declared in
		// GATE_DEFS but referenced by no tool (typo'd reference elsewhere, or dead
		// data) fails. Uses the REAL registry populated by the migrated extensions.
		expect(() => assertEveryGateReferenced(MIGRATED_EXTENSIONS)).not.toThrow();
	});

	test("NEGATIVE: an orphaned GATE_DEFS id fails the reverse invariant", () => {
		GATE_DEFS["__orphan"] = { id: "__orphan", keywords: ["never"] };
		expect(() => assertEveryGateReferenced(MIGRATED_EXTENSIONS)).toThrow(/referenced by NO registered tool/);
		delete GATE_DEFS["__orphan"];
	});
});

// ────────────────────────────────────────────────────────────────────
// Reference form (wayfinder ticket 01, phase 01c): `gating: { gate: "<id>" }`
// is the ONLY non-core form — the inline keywords/requires shape was deleted.
// The net must validate the RESOLVED registry spec.
// ────────────────────────────────────────────────────────────────────
describe("drift-guard — reference form (gating:{gate:id})", () => {
	const saved = { ...GATE_DEFS };
	afterEach(() => {
		// Restore the shared registry — tests must not leak declared gates.
		for (const k of Object.keys(GATE_DEFS)) delete GATE_DEFS[k];
		Object.assign(GATE_DEFS, saved);
	});

	test("reference to a known fireable gate id passes the net", () => {
		GATE_DEFS["flux2"] = { id: "flux2", keywords: ["flux", "flux2"] };
		const def = { name: "flux2", gating: { gate: "flux2" } } as ToolDef;
		expect(() => validateGating(def)).not.toThrow();
	});

	test("reference form uses the REGISTRY spec — fireability comes from GATE_DEFS, not the def", () => {
		// The def carries no keywords at all; fireability must come from GATE_DEFS.
		GATE_DEFS["ltx"] = { id: "ltx", requires: { nouns: ["video"], verbs: ["generate"] } };
		const def = { name: "ltx", gating: { gate: "ltx" } } as ToolDef;
		expect(() => validateGating(def)).not.toThrow();
	});

	test("NEGATIVE: reference to an UNKNOWN gate id fails the net (declaration bug)", () => {
		const def = { name: "ghost", gating: { gate: "no-such-gate" } } as ToolDef;
		expect(() => validateGating(def)).toThrow(/references unknown gate id 'no-such-gate'/);
	});

	test("NEGATIVE: reference to a DEAD registry spec fails the net", () => {
		// A registered id whose spec has no keywords and no fireable requires can
		// never fire — same dead-gate rule, applied to the resolved spec.
		GATE_DEFS["dead"] = { id: "dead" };
		const def = { name: "dead_tool", gating: { gate: "dead" } } as ToolDef;
		expect(() => validateGating(def)).toThrow(/DEAD GATE/);
	});

	test("NEGATIVE: non-core gating with NO gate reference fails the net (inline form deleted in 01c)", () => {
		// The legacy inline form ({ keywords } / { requires } / { core: false })
		// no longer exists — such a def is a declaration bug, not a valid gate.
		const inline = { name: "legacy", gating: { keywords: ["kw"] } } as ToolDef;
		expect(() => validateGating(inline)).toThrow(/without a `gate` reference/);
	});

	test("core:true wins over a gate reference (a core tool with a stray id is still core)", () => {
		GATE_DEFS["corex"] = { id: "corex", keywords: ["x"] };
		const def = { name: "tool", gating: { core: true, gate: "corex" } } as ToolDef;
		expect(() => validateGating(def)).not.toThrow();
	});
});

// ────────────────────────────────────────────────────────────────────
// Probe core list (the #1946 CI net): s2-agent-ext-devops's tools-active-probe
// hardcodes the core builtins it asserts ACTIVE, because the probe file it
// writes for the deployed agent to load must import NOTHING. This guard pins
// that literal against tool-gate's BUILTIN_CORE so the two can never drift —
// a new builtin added here without the probe would silently ship unguarded.
// ────────────────────────────────────────────────────────────────────
describe("drift-guard — probe core list (the #1946 CI net)", () => {
	test("BUILTIN_CORE (tool-gate) and TOOLS_PROBE_CORE (devops tools-active-probe) are the same set", () => {
		expect([...BUILTIN_CORE].sort()).toEqual([...TOOLS_PROBE_CORE].sort());
	});
});
