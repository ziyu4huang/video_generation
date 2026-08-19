/**
 * subagent-model-floor — inject `OB_SUBAGENT_MODEL` from
 * `obsidian.subagentModel` in ~/.pi/agent/settings.json before main() runs.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * The real pi TUI (pi-coding-agent `main()`) does NOT publish
 * `OB_PARENT_MODEL` or `OB_SUBAGENT_MODEL` (confirmed: zero hits for either
 * name in the pi-coding-agent dist). pi-obsidian's `runSubagent` — used by
 * `obsidian_distill` / `obsidian_garden` / `zk_card` / `zk_ask`
 * — resolves its child model via `resolveSubagentModel()`:
 *
 *    1. opts.model (per-call)   2. OB_SUBAGENT_MODEL (floor)
 *    3. OB_PARENT_MODEL         4. pi default  ← warns "no subagent model
 *                                                 configured" + inherits the
 *                                                 (slow) core default.
 *
 * With neither env var set by the TUI, every distill with no `--model` hits
 * path 4 → the warning + a slow inherited model → timeouts (the root cause of
 * the distill reliability bug). This patch closes that gap: read the persistent
 * floor from settings.json and publish it as `OB_SUBAGENT_MODEL` at startup.
 *
 * The floor path (2) is never weakness-checked, so a `/flash` model
 * (e.g. `deepseek/deepseek-v4-flash`) is silent here — this is the CORRECT
 * channel for a fast model (per-call `--model` would trip the weak-warning).
 * An explicit `OB_SUBAGENT_MODEL` env var still wins (per-session override).
 *
 * MODE GATING
 * -----------
 * Mode-agnostic: a distill floor is useful in every mode. No-op when the
 * settings field is absent or the env var is already set. Gated by
 * `BUN_PI_SUBAGENT_MODEL_FLOOR` (default on) via PATCH_TABLE.
 *
 * TESTABILITY
 * -----------
 * `resolveSubagentFloor()` is pure (settings + env in, floor string | undefined
 * out); the import-time side effect is a thin wrapper. Mirrors the
 * resolveEnvBridges / resolvePatchPlan split.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pure: given parsed settings + env, return the floor model id to inject (or
 * undefined to do nothing). Returns undefined when:
 *   - `OB_SUBAGENT_MODEL` is already set in env (env override wins), OR
 *   - `settings.obsidian.subagentModel` is absent / non-string / blank.
 * A non-blank string is returned trimmed.
 */
export function resolveSubagentFloor(
	settings: Record<string, unknown> | undefined,
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	// Env override wins — never clobber an explicit OB_SUBAGENT_MODEL.
	if (env.OB_SUBAGENT_MODEL) return undefined;
	const floor = (settings as any)?.obsidian?.subagentModel;
	if (typeof floor !== "string") return undefined;
	const trimmed = floor.trim();
	return trimmed || undefined;
}

/** Best-effort read of ~/.pi/agent/settings.json. Non-fatal: undefined on any
 *  read/parse error or missing file. (Same shape as pi-agent-cli's reader.) */
function readUserSettings(): Record<string, unknown> | undefined {
	try {
		const settingsPath = join(getAgentDir(), "settings.json");
		if (!existsSync(settingsPath)) return undefined;
		return JSON.parse(readFileSync(settingsPath, "utf8"));
	} catch {
		return undefined;
	}
}

// Import-time side effect: publish the floor as OB_SUBAGENT_MODEL before main()
// reads anything. Runs inside applyPatches() (after ensure-extension-deps sets
// up the @earendil-works/pi-coding-agent import symlinks).
const floor = resolveSubagentFloor(readUserSettings());
if (floor) {
	process.env.OB_SUBAGENT_MODEL = floor;
}

if (
	floor &&
	(process.env.BUN_PI_DEBUG_PATCHES === "1" ||
		process.env.BUN_PI_DEBUG_PATCHES === "true")
) {
	console.error("[bun-pi] subagent-model-floor set OB_SUBAGENT_MODEL:", floor);
}
