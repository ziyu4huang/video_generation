/**
 * tools-active-probe — the ONE probe that asserts the session's ACTIVE toolset
 * still contains the core builtins (read/write/edit/bash).
 *
 * WHY THIS EXISTS
 * ----------------
 * Bug #1946 (2026-08-24): pi 0.84.2's fixed-shape ExtensionAPI hid the
 * patch-added `getAllToolDefinitions` from the `pi` object extensions hold →
 * tool-gate's discovery read returned empty → `setActiveTools([])` wiped the
 * deployed session's toolset. Every gate passed it: boot (`--help`), ext-load
 * (`--ext-list` proves REGISTRATION, not activation), and the model call
 * ("Reply with exactly: ok" — a toolless model still answers ok). Two shipped
 * deploys were toolless before anyone noticed. Registration checks are blind
 * to this class; only the ACTIVE set — what the provider request carries —
 * observes it.
 *
 * The probe is shared by three surfaces so they can never drift:
 *   - deploy-e2e's `tools-probe` (every deploy + local_ci regression-gates)
 *   - tests/deploy-probe-e2e.test.ts (real-session regression, PI_AGENT_E2E)
 *   - s2-agent `doctor --smoke` (dev-side early warning, via relative import)
 *
 * ORDERING (the subtle part — a naive probe is a FALSE GREEN)
 * -----------------------------------------------------------
 * `-e` user extensions load FIRST (resource-loader mergePaths puts CLI
 * extensions ahead of the deploy's inline factories), so a probe's
 * `session_start` handler fires BEFORE tool-gate's (order 190, last). Reading
 * the active set there would return the PRE-gate state even on a buggy build.
 * The probe therefore listens on `before_agent_start` (a LATER event, after
 * tool-gate's session_start already ran) AND defers the read through an
 * UN-AWAITED setTimeout(250ms) so every handler in that event — including
 * ones registered after the probe — has completed by read time. An awaited
 * defer would block the emit loop and defeat exactly that.
 *
 * The exit happens before the agent loop awaits any provider RESPONSE (a
 * request may already have been fired; the probe does not need its completion,
 * and process.exit cancels it — same offline posture as the model-call probe,
 * minus the round trip).
 *
 * The probe source itself must import NOTHING: it is written to a tmpdir and
 * loaded by the deployed agent's own bun.
 */

/**
 * The core builtins whose absence from the ACTIVE set is the #1946 signature.
 * Literal mirror of tool-gate's `BUILTIN_CORE`
 * (s2-agent-ext-tool-gate/extensions/tool-gate.ts) — the probe file cannot
 * import it, so a drift-guard test pins the two sets equal.
 */
export const TOOLS_PROBE_CORE = ["read", "write", "edit", "bash"] as const;

/** Payload the probe prints as one `[TOOLS] <json>` stderr line. */
export interface ToolsProbePayload {
	/** Registered tools (pi.getAllTools().length) — report-only context. */
	total: number;
	/** Tools whose sourceInfo.path matches PI_SMOKE_MARKER — doctor's #182 signal. */
	matched: number;
	/** Active tool count (pi.getActiveTools().length). */
	activeCount: number;
	/** Active tool names. */
	active: string[];
	/** TOOLS_PROBE_CORE names absent from `active` — non-empty is the FAIL. */
	missing: string[];
	/** tool-gate self-report via the __piToolGateStatus seam; null when absent. */
	gateSeam: { activeCount: number; totalCount: number; coreCount: number } | null;
	/** False when the ExtensionAPI no longer exposes getActiveTools (FAIL). */
	getActiveTools: boolean;
	/** Set when getActiveTools() threw — reported, treated as a FAIL by callers. */
	getError?: string;
}

/**
 * The probe source. Import-free; see module header for the ordering contract.
 * Kept as a joined string array (the shape doctor.ts's original SMOKE_PROBE
 * used) for diff-ability.
 */
export const TOOLS_ACTIVE_PROBE = [
	"export default (pi) => {",
	'  pi.on("before_agent_start", () => {',
	"    // UN-awaited: the handler returns immediately so the emit loop reaches",
	"    // later-registered handlers (tool-gate) before the read happens.",
	"    setTimeout(() => {",
	'      const core = ["read", "write", "edit", "bash"];',
	"      const payload = {",
	"        total: 0,",
	"        matched: 0,",
	"        activeCount: -1,",
	"        active: [],",
	"        missing: [],",
	"        gateSeam: null,",
	"        getActiveTools: true,",
	"      };",
	"      try {",
	'        const tools = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];',
	"        payload.total = tools.length;",
	'        const marker = process.env.PI_SMOKE_MARKER ?? "";',
	"        for (const t of tools) {",
	'          if (marker && String((t && t.sourceInfo && t.sourceInfo.path) || "").includes(marker)) payload.matched++;',
	"        }",
	"      } catch {}", // total/matched are report-only — never gate on them
	'      if (typeof pi.getActiveTools === "function") {',
	"        try {",
	"          const active = pi.getActiveTools();",
	// getActiveTools() is getActiveToolNames() on pi 0.84.x — STRINGS. The
	// typeof guard keeps the probe correct if it ever returns tool objects.
	"          payload.active = Array.from(active, (t) => (typeof t === \"string\" ? t : t && t.name)).filter((n) => typeof n === \"string\");",
	"          payload.activeCount = payload.active.length;",
	"          payload.missing = core.filter((n) => !payload.active.includes(n));",
	"        } catch (e) {",
	'          payload.getError = String(e && e.message ? e.message : e);',
	"        }",
	"      } else {",
	"        payload.getActiveTools = false;",
	"      }",
	"      try {",
	'        const seam = globalThis.__piToolGateStatus;',
	'        if (typeof seam === "function") {',
	"          const s = seam();",
	"          if (s) payload.gateSeam = { activeCount: s.activeCount, totalCount: s.totalCount, coreCount: s.coreCount };",
	"        }",
	"      } catch {}", // gate seam is report-only
	'      process.stderr.write("[TOOLS] " + JSON.stringify(payload) + "\\n");',
	"      process.exit(0);",
	"    }, 250);",
	"  });",
	"};",
].join("\n");

/**
 * Parse the `[TOOLS] <json>` line out of captured stderr. Pure.
 * Consumed by deploy-e2e-recipe's tools-probe and doctor's runtime smoke so
 * the two can never disagree about the payload shape.
 */
export function parseToolsProbeLine(stderr: string): { ok: true; value: ToolsProbePayload } | { ok: false; message: string } {
	const clean = stderr.replace(/\x1b\[[0-9;]*m/g, "");
	const m = clean.match(/\[TOOLS\] (\{[^\n]*\})/);
	if (!m) return { ok: false, message: "tools probe never reported — [TOOLS] line absent" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(m[1] ?? "");
	} catch {
		return { ok: false, message: "[TOOLS] line is not valid JSON" };
	}
	const v = parsed as Partial<ToolsProbePayload>;
	if (
		typeof v.total !== "number" ||
		typeof v.matched !== "number" ||
		typeof v.activeCount !== "number" ||
		!Array.isArray(v.active) ||
		!Array.isArray(v.missing) ||
		typeof v.getActiveTools !== "boolean"
	) {
		return { ok: false, message: "[TOOLS] payload malformed (missing total/activeCount/active/missing/getActiveTools)" };
	}
	return { ok: true, value: v as ToolsProbePayload };
}
