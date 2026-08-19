/**
 * PI_DEBUG_MODELS — the single env knob that surfaces every model-id decision
 * (which tier/capability was requested, which precedence branch won, where the
 * model-tiers config came from, whether scope clamped the result).
 *
 * Read at CALL time (plain process.env), so it behaves identically in source
 * runs, legacy deploys, and the compiled sh binary — `PI_DEBUG_MODELS=1` on
 * any launch. Output goes to stderr with a `[models]` tag, one decision per
 * line, safe to leave on while interacting with the TUI.
 *
 * The sibling BUN_PI_DEBUG_PATCHES covers the pi-agent host-side startup
 * decisions (default-model splice, subagent floor, tier-config seeding); the
 * pi-agent patches also honor PI_DEBUG_MODELS so ONE knob really covers all
 * model decisions, startup and per-dispatch.
 */

/** True when PI_DEBUG_MODELS asks for model-decision logging ("1"/"true"). */
export function debugModelsEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env.PI_DEBUG_MODELS === "1" || env.PI_DEBUG_MODELS === "true";
}

/**
 * Emit one decision line: `[models] <where> key=value key=value…` — but only
 * when PI_DEBUG_MODELS is set. Values are JSON-encoded so specs containing
 * `:` or `/` stay unambiguous.
 */
export function logModelDecision(where: string, fields: Record<string, unknown>): void {
	if (!debugModelsEnabled()) return;
	const parts = Object.entries(fields).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
	console.error(`[models] ${where} ${parts.join(" ")}`);
}
