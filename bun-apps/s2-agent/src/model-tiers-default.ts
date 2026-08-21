/** Built-in default model-tier config for @repo/s2-agent.
 *
 * Mirrors the "glm-lmstudio" preset in s2-agent-ext-subagent/src/presets.ts and
 * the canonical ~/.pi/workflows/model-tiers.json. Seeded to that file at startup
 * by the ensure-model-tiers patch IF (and only if) the file is absent — it never
 * clobbers a user's live config. Kept as typed TS (not loose JSON) so the team's
 * preferred tier→model routing ships with the package and is version-controlled.
 *
 * NOTE: this bakes provider ids (zai/glm-*, lm-studio/gemma-*) into the shared
 * host package — appropriate for this repo where these are the standard
 * providers. The seed is idempotent + env-gated (BUN_PI_ENSURE_MODEL_TIERS=0 to
 * disable), so it never overwrites an existing file. */
export interface ModelTierConfig {
	tiers: { small: string; medium: string; big: string };
	capabilities: Record<string, string>;
}

export const DEFAULT_MODEL_TIER_CONFIG: ModelTierConfig = {
	tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.3", big: "zai/glm-5.3" },
	capabilities: {
		vision: "lm-studio/google/gemma-4-12b",
		"vision-large": "lm-studio/google/gemma-4-12b",
		"vision-medium": "lm-studio/google/gemma-4-12b",
		"vision-small": "lm-studio/google/gemma-4-12b",
	},
};

/** Pure: serialize the config the same way /models-preset writes it. Testable. */
export function buildModelTiersJson(config: ModelTierConfig = DEFAULT_MODEL_TIER_CONFIG): string {
	return JSON.stringify(config, null, 2) + "\n";
}

/** Pure: decide whether the ensure-seed should write. Testable. */
export function shouldEnsureModelTiers(opts: { fileExists: boolean; enabled: boolean }): boolean {
	return opts.enabled && !opts.fileExists;
}
