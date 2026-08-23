/**
 * tool-gate-fire — deploy-side gate for the shipped tool-gate matcher.
 *
 * WHY THIS EXISTS
 * ---------------
 * tool-gate joined the s2-agent-sh base set on measured evidence (2026-08-23
 * reversal: the dist carries 74% of the full-tree gate-managed schema mass),
 * with a documented caveat: its recall corpus and gate-recall probes stay
 * repo-side — the dist ships without its QA harness. This probe is the
 * deploy-side counterpart: it executes the DEPLOYED ext/tool-gate bundle
 * (`ext.cjs`, evaluated by the runtime loader with host modules served for
 * real — no model, no agent loop, offline) and drives one deterministic
 * session-start → per-turn cycle over a fixture gate family.
 *
 * WHAT A PASS PROVES
 *   - session_start: the gated fixture tool is OFF while the built-in core
 *     (read/bash, BUILTIN_CORE-injected) and the declared core are ON —
 *     the shipped matcher actually filters, and GATE_DEFS identity holds
 *   - before_agent_start with a prompt containing the fixture keyword: the
 *     gate fires (sticky) and the tool reactivates — the shipped bytes match
 *   - enable_tool, the escape hatch, is registered
 *   - BUN_PI_TOOL_GATE=0 makes the shipped bundle a no-op — the base-set
 *     disable-env contract holds in the bundle, not just in source
 *
 * The full recall corpus / gate-recall probes remain repo-side; this is the
 * smoke layer, exactly what the file2md-ocr probe is to file2md.
 */
import { GATE_DEFS, type Gate } from "@repo/s2-agent-core-interface";
import { evaluateExtBundle } from "./deploy/lib/ext-build.js";

/** Fixture family id — registered into GATE_DEFS for the run only. */
const FIXTURE_GATE_ID = "e2e-tool-gate-fire";
const FIXTURE_GATE: Gate = {
	id: FIXTURE_GATE_ID,
	keywords: ["pixelize"],
	description: "deploy e2e fixture gate — removed after the run",
};

/**
 * Fixture tool defs returned by the mock pi. `read`/`bash` carry NO gating —
 * the deployed bundle's BUILTIN_CORE injection must make them core. The gated
 * tool references the fixture family id; an unknown id fail-opens (the tool
 * stays always-active), which trips the session_start assertion below instead
 * of silently passing.
 */
const FIXTURE_DEFS: Array<{
	name: string;
	description?: string;
	parameters?: unknown;
	gating?: { core?: boolean; gate?: string };
}> = [
	{ name: "read", description: "Read a file" },
	{ name: "bash", description: "Execute a shell command" },
	{ name: "e2e_fire_core", description: "fixture always-active tool", gating: { core: true } },
	{ name: "e2e_fire_gated", description: "fixture gated tool", gating: { gate: FIXTURE_GATE_ID } },
];

const FIRING_PROMPT = "please pixelize the render before exporting";
/** All fixture names that must be active at session start (core, ungated). */
const START_CORE = ["read", "bash", "e2e_fire_core"];

export interface ToolGateFireResult {
	ok: boolean;
	note: string;
	detail?: string;
}

interface MockApi {
	handlers: Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>;
	activeSets: string[][];
	registered: string[];
	getAllToolDefinitions: () => unknown[];
	on: (event: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) => void;
	setActiveTools: (names: string[]) => void;
	registerTool: (tool: { name: string }) => void;
}

/** The minimal pi surface tool-gate touches. */
function makeMockApi(): MockApi {
	const api: MockApi = {
		handlers: new Map(),
		activeSets: [],
		registered: [],
		getAllToolDefinitions: () => FIXTURE_DEFS.map((d) => ({ ...d })),
		on: (event, handler) => api.handlers.set(event, handler),
		setActiveTools: (names) => api.activeSets.push(names),
		registerTool: (tool) => api.registered.push(tool.name),
	};
	return api;
}

/** Default ctx shape the entry needs to be harmless: banner + session id. */
const CTX = {
	ui: { theme: { fg: (_k: string, s: string) => s }, setWidget: () => undefined },
	sessionManager: { getSessionId: () => "e2e-fire" },
};

/**
 * Run the deployed tool-gate bundle through the cycle. Never throws — every
 * deviation is a structured result; a bundle that cannot be evaluated at all
 * is a fail with the eval error in `note`.
 */
export async function runToolGateFireProbe(
	extCjsPath: string,
	hostModules: readonly string[],
): Promise<ToolGateFireResult> {
	try {
		return await probeOnBundle(extCjsPath, hostModules);
	} catch (e) {
		return { ok: false, note: `execution failed: ${e instanceof Error ? e.message : String(e)}` };
	}
}

/** The actual probe; every throw here becomes the structured fail above. */
async function probeOnBundle(
	extCjsPath: string,
	hostModules: readonly string[],
): Promise<ToolGateFireResult> {
	// Fixture registration and the GATE_DEFS identity: buildEffectiveGates
	// resolves `gating: { gate }` through the SERVED core-interface instance —
	// this import must be the same module the bundle's host require returns,
	// or the fixture gate fail-opens and the session_start assertion fails.
	GATE_DEFS[FIXTURE_GATE_ID] = FIXTURE_GATE;
	try {
		// ── Disable-env contract: BUN_PI_TOOL_GATE=0 registers nothing ────────
		const prevEnv = process.env.BUN_PI_TOOL_GATE;
		try {
			process.env.BUN_PI_TOOL_GATE = "0";
			const { exports: disabledExports } = await evaluateExtBundle(extCjsPath, hostModules);
			const disabledApi = makeMockApi();
			(disabledExports.default as (api: unknown) => void)(disabledApi);
			if (disabledApi.handlers.size !== 0 || disabledApi.registered.length !== 0) {
				return {
					ok: false,
					note: "BUN_PI_TOOL_GATE=0 guard missing in the shipped bundle — the entry registered handlers",
					detail: `handlers: ${[...disabledApi.handlers.keys()].join(", ")}; tools: ${disabledApi.registered.join(", ")}`,
				};
			}
		} finally {
			if (prevEnv === undefined) delete process.env.BUN_PI_TOOL_GATE;
			else process.env.BUN_PI_TOOL_GATE = prevEnv;
		}

		// ── Real run: session start, then a per-turn keyword prompt ───────────
		const { exports } = await evaluateExtBundle(extCjsPath, hostModules);
		const api = makeMockApi();
		(exports.default as (api: unknown) => void)(api);

		const sessionStart = api.handlers.get("session_start");
		if (!sessionStart) {
			return { ok: false, note: "no session_start handler registered by the shipped bundle" };
		}
		await sessionStart(undefined, CTX);

		const startActive = api.activeSets[0] ?? [];
		const startMissing = START_CORE.filter((n) => !startActive.includes(n));
		if (startActive.includes("e2e_fire_gated")) {
			return {
				ok: false,
				note: "the gated fixture tool was ACTIVE at session start — the shipped matcher is not gating (fixture id unregistered or build broken)",
				detail: `active: ${startActive.join(", ")}`,
			};
		}
		if (startMissing.length > 0) {
			return {
				ok: false,
				note: "core fixture tools missing from the session-start active set",
				detail: `missing: ${startMissing.join(", ")}; active: ${startActive.join(", ")}`,
			};
		}

		const perTurn = api.handlers.get("before_agent_start");
		if (!perTurn) {
			return { ok: false, note: "no before_agent_start handler registered by the shipped bundle" };
		}
		await perTurn({ prompt: FIRING_PROMPT }, CTX);

		const turnActive = api.activeSets[api.activeSets.length - 1] ?? [];
		if (!turnActive.includes("e2e_fire_gated")) {
			return {
				ok: false,
				note: "the keyword prompt did NOT reactivate the gated fixture tool — the shipped matcher does not match",
				detail: `prompt: ${JSON.stringify(FIRING_PROMPT)}; active: ${turnActive.join(", ")}; active-sets: ${api.activeSets.map((s) => `[${s.join(", ")}]`).join(" → ")}`,
			};
		}

		if (!api.registered.includes("enable_tool")) {
			return { ok: false, note: "enable_tool escape hatch not registered by the shipped bundle" };
		}

		return {
			ok: true,
			note: `deployed bundle gated at session start (${startActive.join(", ")}) and fired on keyword (${FIRING_PROMPT})`,
		};
	} finally {
		delete GATE_DEFS[FIXTURE_GATE_ID];
	}
}
