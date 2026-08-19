/**
 * default-model-env — bridge pi-agent-cli's PI_MODEL / PI_PROVIDER /
 * PI_THINKING env overrides into the real pi TUI's argv, and splice the
 * package's BUILT-IN default model when nothing else is configured.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * The real pi TUI resolves its default model ONLY from
 * `~/.pi/agent/settings.json` (defaultModel / defaultProvider /
 * defaultThinkingLevel); it does NOT read PI_MODEL / PI_PROVIDER /
 * PI_THINKING (confirmed: zero hits for those names in the pi-coding-agent
 * dist). pi-agent-cli (the reimplementation in this repo) DOES honor those
 * env vars. So the same `PI_MODEL=...` that works for pi-agent-cli was
 * silently ignored by pi-agent — the wrapper kept falling back to whatever
 * pi's settings.json default was, defeating the custom-provider ergonomics
 * for anyone who lives in the interactive TUI.
 *
 * This patch closes that asymmetry: when the user hasn't passed the flag
 * explicitly, splice the env value into argv so pi honors it. The values pass
 * through pi's own parser, so pi still validates them (e.g. a bad --thinking
 * level is rejected by pi, not silently accepted here).
 *
 * BUILT-IN DEFAULTS (FILL-GAPS SEMANTICS)
 * ---------------------------------------
 * When neither the flag, nor the env var, nor a personal default in
 * ~/.pi/agent/settings.json is present, the package's built-in default
 * (src/builtin-model-default.ts — zai / glm-5.3 / high) is spliced instead,
 * so the TUI works with ZERO personal model config in ~/.pi. Precedence per
 * flag:
 *
 *   explicit argv flag  >  PI_* env var  >  ~/.pi settings.json default  >
 *   built-in default
 *
 * A settings.json default therefore still WINS over the built-in — /model
 * writing a personal default back keeps working (fill-gaps, never override).
 *
 * The settings read resolves $PI_CODING_AGENT_DIR → ~/.pi/agent the same way
 * doctor.ts / tools-metrics.ts do (pure homedir join, NO @earendil-works
 * import) so this patch keeps its place in PATCH_TABLE BEFORE
 * ensure-extension-deps (which is what materializes the @earendil-works
 * import symlinks).
 *
 * MODE GATING
 * -----------
 * Mode-agnostic (source + bundle + binary): unlike skip-update-check (an
 * artifact-noise concern), an env model override is useful in every mode.
 * No-op when none of the three env vars are set, when the corresponding
 * flag is already on the command line, or when a personal default covers it.
 *
 * TESTABILITY
 * -----------
 * resolveEnvBridges() is pure (argv + env + settings in, tokens out); the
 * import-time side effect just calls it and splices. Mirrors the
 * resolvePatchPlan split.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BUILTIN_MODEL_DEFAULT } from "../builtin-model-default.ts";

export interface BridgeEntry {
	/** env var to read (e.g. "PI_MODEL"). */
	env: string;
	/** argv flag to emit (e.g. "--model"). */
	flag: string;
	/** settings.json key that, when present, suppresses the built-in splice
	 * (the personal default wins over the built-in). Optional so ad-hoc
	 * bridges (tests) need not name one. */
	setting?: string;
}

/**
 * The three env overrides pi-agent-cli honors, bridged to the real pi TUI.
 * pi accepts all three long flags and the `provider/id:thinking` shorthand.
 */
export const BRIDGES: readonly BridgeEntry[] = [
	{ env: "PI_MODEL", flag: "--model", setting: "defaultModel" },
	{ env: "PI_PROVIDER", flag: "--provider", setting: "defaultProvider" },
	{ env: "PI_THINKING", flag: "--thinking", setting: "defaultThinkingLevel" },
];

/** Built-in splice values keyed by bridge flag. */
const BUILTIN_BY_FLAG: Record<string, string> = {
	"--model": BUILTIN_MODEL_DEFAULT.model,
	"--provider": BUILTIN_MODEL_DEFAULT.provider,
	"--thinking": BUILTIN_MODEL_DEFAULT.thinking,
};

/** A settings value counts as "present" only when it's a non-blank string. */
function settingPresent(
	settings: Record<string, unknown> | undefined,
	key: string,
): boolean {
	const v = settings?.[key];
	return typeof v === "string" && v.trim() !== "";
}

/**
 * Pure: which argv tokens WOULD be spliced for a given argv + env (+ optional
 * personal settings + built-in defaults), without touching process.argv.
 * Returns a flat array (flag, value, flag, value, …). Per bridge:
 *   - skip when the flag is already present in argv (space or `=` form),
 *   - else splice the env value when the env var is set (non-empty),
 *   - else skip when the personal settings default is present (pi reads it),
 *   - else splice the built-in value when one is provided for the flag.
 */
export function resolveEnvBridges(
	argv: readonly string[],
	env: Record<string, string | undefined> = process.env,
	bridges: readonly BridgeEntry[] = BRIDGES,
	opts: {
		settings?: Record<string, unknown> | undefined;
		builtinByFlag?: Record<string, string>;
	} = {},
): string[] {
	const { settings, builtinByFlag } = opts;
	const extra: string[] = [];
	for (const { env: key, flag, setting } of bridges) {
		const prefix = flag + "=";
		// argv is scanned as-is; the flag can't appear in nodePath/scriptPath.
		if (argv.some((a) => a === flag || a.startsWith(prefix))) continue;
		const val = env[key];
		if (val) {
			extra.push(flag, val);
			continue;
		}
		if (setting && settingPresent(settings, setting)) continue;
		const builtin = builtinByFlag?.[flag];
		if (builtin) extra.push(flag, builtin);
	}
	return extra;
}

/** Best-effort read of the user settings file (<agentDir>/settings.json,
 * where agentDir = $PI_CODING_AGENT_DIR ?? ~/.pi/agent). Non-fatal: returns
 * undefined on any read/parse error or missing file. No @earendil-works
 * import — see the header for why the ordering matters. */
export function readAgentSettings(
	env: Record<string, string | undefined> = process.env,
): Record<string, unknown> | undefined {
	try {
		const dir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
		const settingsPath = join(dir, "settings.json");
		if (!existsSync(settingsPath)) return undefined;
		return JSON.parse(readFileSync(settingsPath, "utf8"));
	} catch {
		return undefined;
	}
}

// Import-time side effect: splice the bridged flags into argv before main()
// reads it. Position 2 = just after [nodePath, scriptPath], ahead of any user
// args (pi parses flags position-independently, so splice order is cosmetic).
const extra = resolveEnvBridges(process.argv, process.env, BRIDGES, {
	settings: readAgentSettings(),
	builtinByFlag: BUILTIN_BY_FLAG,
});
if (extra.length) {
	process.argv.splice(2, 0, ...extra);
}

if (
	extra.length &&
	(process.env.BUN_PI_DEBUG_PATCHES === "1" ||
		process.env.BUN_PI_DEBUG_PATCHES === "true" ||
		process.env.PI_DEBUG_MODELS === "1" ||
		process.env.PI_DEBUG_MODELS === "true")
) {
	console.error("[bun-pi] default-model-env spliced argv:", extra);
}
