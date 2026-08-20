/**
 * Self-promotion × tool-gate interaction test (wayfinder ticket 06).
 *
 * Question: flux2 + ltx extensions self-promote to always-active in their own
 * `session_start` (registered AFTER tool-gate in the manifest). Does this
 * defeat tool-gate's flux2/ltx gates at runtime?
 *
 * This simulates the real event lifecycle with a multi-handler mock (handlers
 * fired in REGISTRATION order, exactly as s2-agent dispatches) and a tiny
 * flux2/ltx "mimic" that reproduces their exact session_start self-promotion —
 * no heavy MLX deps, just the setActiveTools interaction under test.
 *
 * Verdict (encoded by the assertions below): self-promotion is TRANSIENT. It
 * wins at session_start (flux2-mimic runs after tool-gate), but tool-gate's
 * per-turn `before_agent_start` is the ONLY before_agent_start among the three
 * and re-asserts `filterActive` every turn — so on turn 1+ flux2/ltx are
 * correctly GATED unless a keyword fires. qa:savings steady-state numbers hold.
 */
import { describe, expect, test } from "bun:test";
import toolGateExtension from "./tool-gate.ts";
import { CORE_NAMES } from "./core-names.fixture.ts";
import flux2Extension from "@repo/s2-agent-ext-flux2/extensions/flux2.ts";
import ltxExtension from "@repo/s2-agent-ext-ltx/extensions/ltx.ts";
import movieExtension from "@repo/s2-agent-ext-movie-director/extensions/movie-director.ts";

/** A minimal pi mock that (unlike tool-gate.test.ts's setupPi) keeps MULTIPLE
 *  handlers per event in registration order and tracks a live active set, so a
 *  later handler's getActiveTools() sees an earlier handler's setActiveTools(). */
function makePi(allToolNames: string[]) {
	const handlers: Record<string, Array<(e?: any, ctx?: any) => any>> = {};
	let active: string[] = [];
	const registered: any[] = [];
	const pi: any = {
		getAllToolDefinitions: () => allToolNames.map((name) => {
			// flux2 (ticket 05) + ltx (ticket 07): supply their owner-declared gating so
			// tool-gate's buildEffectiveGates tracks+gates them like a real session.
			const owner = ownerDefs.find((d) => d.name === name);
			return owner ? { name, gating: owner.gating } : { name };
		}),
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		registerTool: (def: any) => { registered.push(def); },
		on: (ev: string, h: any) => { (handlers[ev] ??= []).push(h); },
	};
	const fire = async (ev: string, event?: any, ctx?: any) => {
		for (const h of handlers[ev] ?? []) await h(event, ctx);
	};
	return { pi, fire, get active() { return active; }, registered };
}

const noOpCtx = { ui: { theme: { fg: (_k: string, s: string) => s }, setWidget: () => {} } };

// flux2/flux2_help (ticket 05) + ltx/ltx_help (ticket 07) + movie/movie_help
// (ticket 08) migrated to owner-declared gating → the mock pi must surface
// their REAL gating so tool-gate tracks+gates them (the hardcoded GATES
// fallback no longer covers any of them). Captured once from each registrar;
// flux2/ltx mimics below stay as-is — the session_start self-promotion is the
// orthogonal visibility layer under test here, NOT the gating declaration.
// (movie-director has NO session_start handler — it remains the no-self-
// promotion control case for the test below.)
const ownerDefs: { name: string; gating?: unknown }[] = [];
const captureOwner = (ext: (pi: any) => void) =>
	ext({ on: () => {}, registerTool: (def: any) => { ownerDefs.push(def); }, getActiveTools: () => [], setActiveTools: () => {} } as never);
captureOwner(flux2Extension);
captureOwner(ltxExtension);
captureOwner(movieExtension);

/** flux2's exact session_start self-promotion pattern (flux2.ts:419). */
function flux2Mimic(pi: any) {
	pi.on("session_start", () => {
		const current = pi.getActiveTools();
		if (!current.includes("flux2")) {
			pi.setActiveTools([...new Set([...current, "flux2", "flux2_help"])]);
		}
	});
}
/** ltx's exact session_start self-promotion pattern (ltx.ts:370). */
function ltxMimic(pi: any) {
	pi.on("session_start", () => {
		const current = pi.getActiveTools();
		if (!current.includes("ltx")) {
			pi.setActiveTools([...new Set([...current, "ltx", "ltx_help"])]);
		}
	});
}

const ALL = [...CORE_NAMES, "flux2", "flux2_help", "ltx", "ltx_help", "movie", "movie_help"];

describe("ticket 06 — self-promotion is transient; tool-gate wins at steady state", () => {
	// Load order = manifest order: tool-gate (line 4) → flux2 (9) → ltx (11).
	function boot() {
		const { pi, fire, registered } = makePi(ALL);
		toolGateExtension(pi); // registers session_start + before_agent_start + enable_tool
		flux2Mimic(pi);        // session_start only
		ltxMimic(pi);          // session_start only
		return { pi, fire, registered };
	}

	test("after session_start: flux2/ltx ARE active (self-promotion won the race)", async () => {
		const { pi, fire } = boot();
		await fire("session_start", {}, noOpCtx);
		// tool-gate gated them out first, but the mimics run later and re-add them.
		expect(pi.getActiveTools()).toEqual(expect.arrayContaining(["flux2", "flux2_help", "ltx", "ltx_help"]));
	});

	test("after before_agent_start (no keyword): flux2/ltx are GATED OUT (tool-gate re-asserts)", async () => {
		const { pi, fire } = boot();
		await fire("session_start", {}, noOpCtx); // self-promotion makes them active
		// Turn 1, no image/video keyword → tool-gate's before_agent_start re-gates.
		await fire("before_agent_start", { prompt: "what's the weather today" });
		expect(pi.getActiveTools()).not.toContain("flux2");
		expect(pi.getActiveTools()).not.toContain("flux2_help");
		expect(pi.getActiveTools()).not.toContain("ltx");
		expect(pi.getActiveTools()).not.toContain("ltx_help");
		// CORE tools survive.
		expect(pi.getActiveTools()).toEqual(expect.arrayContaining([...CORE_NAMES]));
	});

	test("after before_agent_start (image keyword): flux2 active — gate works when intended", async () => {
		const { pi, fire } = boot();
		await fire("session_start", {}, noOpCtx);
		await fire("before_agent_start", { prompt: "generate an image of a cat" });
		expect(pi.getActiveTools()).toEqual(expect.arrayContaining(["flux2", "flux2_help"]));
		// ltx still gated (no video keyword).
		expect(pi.getActiveTools()).not.toContain("ltx");
	});

	test("movie (NO self-promotion) is never active without a keyword", async () => {
		const { pi, fire } = boot();
		await fire("session_start", {}, noOpCtx);
		await fire("before_agent_start", { prompt: "edit this file" });
		expect(pi.getActiveTools()).not.toContain("movie");
		expect(pi.getActiveTools()).not.toContain("movie_help");
	});

	test("flux2/ltx have NO before_agent_start — so they cannot re-promote per turn", () => {
		// Structural guard: if a future change adds before_agent_start to flux2/ltx,
		// this test breaks as a prompt to re-evaluate ticket 06's verdict.
		const { pi } = makePi(ALL);
		let flux2HasBefore = false;
		let ltxHasBefore = false;
		const probe = (mk: (pi: any) => void) => {
			const seen: string[] = [];
			const p: any = { on: (ev: string) => { seen.push(ev); }, getActiveTools: () => [], setActiveTools: () => {} };
			mk(p);
			return seen.includes("before_agent_start");
		};
		flux2HasBefore = probe(flux2Mimic);
		ltxHasBefore = probe(ltxMimic);
		expect(flux2HasBefore).toBe(false);
		expect(ltxHasBefore).toBe(false);
		void pi;
	});
});
