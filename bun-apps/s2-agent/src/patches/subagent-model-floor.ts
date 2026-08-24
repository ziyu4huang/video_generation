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
 * Mode-agnostic: a distill floor is useful in every mode. No-op when the env
 * var is already set; when the personal settings floor is absent the built-in
 * default floor (BUILTIN_MODEL_DEFAULT in src/pre-load-providers.ts) fills the
 * gap — zero ~/.pi
 * config required. Gated by `BUN_PI_SUBAGENT_MODEL_FLOOR` (default on) via
 * PATCH_TABLE.
 *
 * TESTABILITY
 * -----------
 * `resolveSubagentFloor()` is pure (settings + env in, floor string | undefined
 * out); the import-time side effect is a thin wrapper. Mirrors the
 * resolveEnvBridges / resolvePatchPlan split.
 */
import { BUILTIN_MODEL_DEFAULT } from "../pre-load-providers.ts";
import { readAgentSettings } from "../paths.ts";
import { isPatchOrModelsDebug } from "./index.ts";

/**
 * Pure: given parsed settings + env, return the floor model id to inject (or
 * undefined to do nothing). Returns undefined when `OB_SUBAGENT_MODEL` is
 * already set in env (env override wins). Otherwise the personal floor
 * (`settings.obsidian.subagentModel`, trimmed) wins; when it is absent /
 * non-string / blank the built-in default floor (BUILTIN_MODEL_DEFAULT) fills
 * the gap — fill-gaps semantics, mirroring applyObsidianSubagentFloor in
 * s2-agent-cli's shared.ts.
 */
export function resolveSubagentFloor(
	settings: Record<string, unknown> | undefined,
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	// Env override wins — never clobber an explicit OB_SUBAGENT_MODEL.
	if (env.OB_SUBAGENT_MODEL) return undefined;
	const floor = (settings as any)?.obsidian?.subagentModel;
	if (typeof floor === "string" && floor.trim()) return floor.trim();
	return BUILTIN_MODEL_DEFAULT.obsidianSubagentFloor;
}

// Import-time side effect: publish the floor as OB_SUBAGENT_MODEL before main()
// reads anything. Runs inside applyPatches(), which imports this module via a
// static-literal path — the settings read goes through the node-builtins-only
// leaf ../paths.ts (no @earendil-works import at all, so no ordering
// dependency on ensure-extension-deps).
const floor = resolveSubagentFloor(readAgentSettings());
if (floor) {
	process.env.OB_SUBAGENT_MODEL = floor;
}

if (floor && isPatchOrModelsDebug()) {
	console.error("[bun-pi] subagent-model-floor set OB_SUBAGENT_MODEL:", floor);
}
