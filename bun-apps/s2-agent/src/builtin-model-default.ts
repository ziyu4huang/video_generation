/** Built-in default LLM config for @repo/s2-agent — the single source of truth.
 *
 * Every "what model do we run when nothing is configured?" decision in this
 * package resolves to BUILTIN_MODEL_DEFAULT: the CLI session fallback
 * (src/cli/sessions/shared.ts FALLBACK), the TUI argv splice
 * (src/patches/default-model-env.ts), and the obsidian subagent floor default
 * (src/patches/subagent-model-floor.ts + applyObsidianSubagentFloor). Keeping
 * the values here means the team's preferred defaults ship with the package,
 * version-controlled, with NO ~/.pi/agent/settings.json required.
 *
 * PRECEDENCE (fill-gaps semantics — built-in never overrides personal config):
 *   explicit flag  >  PI_MODEL/PI_PROVIDER/PI_THINKING env  >
 *   ~/.pi/agent/settings.json (defaultModel/defaultProvider/defaultThinkingLevel)
 *   >  BUILTIN_MODEL_DEFAULT
 * A personal default written back by the TUI's /model command therefore keeps
 * winning over the built-in; customization stays possible at every layer.
 *
 * NOTE: this bakes provider ids (zai, deepseek) into the host package —
 * appropriate for this repo where these are the standard providers. The
 * provider/model catalogs those ids resolve against are also built in
 * (src/pre-load-providers.ts + src/models-store-default.ts). */
export interface BuiltinModelDefault {
	/** Default provider id (must exist in models-store or the baked catalog). */
	provider: string;
	/** Default model id within the provider. */
	model: string;
	/** Default thinking level (one of pi-agent-core's ThinkingLevels). */
	thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	/** Floor model for pi-obsidian distill/garden subagents
	 * (obsidian.subagentModel in settings.json when present). */
	obsidianSubagentFloor: string;
}

export const BUILTIN_MODEL_DEFAULT: BuiltinModelDefault = {
	provider: "zai",
	model: "glm-5.3",
	thinking: "high",
	obsidianSubagentFloor: "deepseek/deepseek-v4-flash",
};
