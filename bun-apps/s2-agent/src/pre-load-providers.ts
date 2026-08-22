/**
 * pre-load-providers — ALL baked model config for @repo/s2-agent in one file:
 *
 *   §1 PROVIDERS        — extension-provider catalog (lm-studio) + registration helpers
 *   §2 BUILTIN_MODEL_DEFAULT — the default provider/model/thinking choice
 *   §3 DEFAULT_MODEL_TIER_CONFIG — tier→model routing seed (model-tiers.json)
 *
 * RETIRED 2026-08-22: §4 DEFAULT_MODELS_STORE (models-store.json seed) was
 * removed — pi 0.84.2's builtin catalog (pi-ai models.generated.js) already
 * ships zai/deepseek/huggingface, so seeding ~/.pi/agent/models-store.json was
 * redundant; the file is now neither seeded nor persisted (see
 * patches/in-memory-models-store.ts).
 *
 * HOW TO ADD A PROVIDER
 * ---------------------
 * Add an entry to PROVIDERS below. Run `bun src/cli.ts --list-models` to verify.
 * No other file needs to change.
 *
 * API KEY
 * -------
 *   apiKey: "literal-string"         — hardcode (OK for local servers with fake keys)
 *   apiKey: { env: "MY_API_KEY" }   — read from environment variable at runtime
 *
 * SIDE-EFFECT-FREE BY DESIGN
 * ---------------------------
 * This module has NO top-level side effects — importing PROVIDERS / resolveApiKey /
 * registerAllProviders from anywhere (including s2-agent-cli, via `@repo/s2-agent`)
 * must never monkey-patch anything. The actual ModelRuntime.create() wrap lives in
 * `./patches/pre-load-providers.ts` and is applied ONLY via applyPatches()
 * (env-gated, main()-oriented). A prior version patched the prototype right here
 * at module scope, which meant ANY import of this file — even just `{ PROVIDERS }`
 * — applied the patch as an ES-module evaluation side effect, double-registering
 * every provider for s2-agent-cli's programmatic session builder (which
 * explicitly imports PROVIDERS to AVOID that patch; see
 * bun-apps/s2-agent/src/cli/sessions/shared.ts). Keep it that way.
 */

// ─── Provider config ──────────────────────────────────────────────────────────

export type ApiKey = string | { env: string };

interface Compat {
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
}

interface ModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  /** Per-model compat; merged ON TOP of the provider-level compat. */
  compat?: Compat;
}

interface ProviderEntry {
  baseUrl: string;
  api: string;
  apiKey: ApiKey;
  /** Provider-level compat, applied to every model (merged with per-model compat). */
  compat?: Compat;
  models: ModelEntry[];
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// LM Studio runs locally with a fake key; both compat flags are off for every
// model it serves, so the compat is declared once at the provider level and
// registerAllProviders merges it onto each model for the extension-provider
// path (which honors only model-level compat via object spread).
const LM_STUDIO_COMPAT: Compat = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
};

export const PROVIDERS: Record<string, ProviderEntry> = {

  "lm-studio": {
    baseUrl: "http://localhost:1234/v1",
    api: "openai-completions",
    apiKey: "lm-studio",
    compat: LM_STUDIO_COMPAT,
    // The local LM Studio models this repo targets. Previously the catalog
    // listed several (gemma-4-26b/31b-qat, qwen3.6-27b-mtp, qwen3-vl-4b); they
    // were consolidated to google/gemma-4-12b — see the "local model"
    // convention across s2-agent-ext-*. qwen/qwen3.8-27b shares the same
    // server settings (same always-on reasoning + shared maxTokens budget).
    models: [
      {
        id: "google/gemma-4-12b",
        name: "Gemma 4 12B (LM Studio)",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200_000,
        // LM Studio's MLX server serves Gemma 4 as an always-on reasoning
        // model: it ignores client-side thinking knobs (thinking:disabled,
        // chat_template_kwargs, reasoning_effort, thinking_token_budget — all
        // verified ignored on this server) and burns 2–10k tokens of
        // reasoning_content before any content. maxTokens is a SHARED budget
        // (reasoning + answer), so a small cap truncates the reply to an empty
        // "length" stop — the "strange message" symptom (session
        // 2026-08-22: output=16383, reasoning=5459, content="").
        // 65_536 keeps headroom for reasoning while staying inside the model's
        // real 262_144 context window.
        maxTokens: 65_536,
      },
      {
        id: "qwen/qwen3.8-27b",
        name: "Qwen 3.8 27B (LM Studio)",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200_000,
        // Same server behavior as gemma-4-12b: LM Studio's MLX server serves
        // Qwen 3.8 as an always-on reasoning model, so keep the same shared
        // maxTokens budget headroom for reasoning + answer.
        maxTokens: 65_536,
      },
    ],
  },

  // "openrouter": {
  //   baseUrl: "https://openrouter.ai/api/v1",
  //   api: "openai-completions",
  //   apiKey: { env: "OPENROUTER_API_KEY" },
  //   models: [
  //     { id: "google/gemma-2-9b-it:free",          name: "Gemma 2 9B (OR free)",   reasoning: false, input: ["text"], contextWindow: 8_192,  maxTokens: 4_096 },
  //     { id: "mistralai/mistral-nemo:free",         name: "Mistral Nemo (OR free)", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 4_096 },
  //     { id: "deepseek/deepseek-chat-v3-0324:free", name: "DeepSeek V3 (OR free)",  reasoning: false, input: ["text"], contextWindow: 64_000,  maxTokens: 8_192 },
  //   ],
  // },

};

/** Resolve an ApiKey spec: a literal string, or {env} → process.env ("" if unset). */
export function resolveApiKey(key: ApiKey, env: Record<string, string | undefined> = process.env): string {
  if (typeof key === "string") return key;
  return env[key.env] ?? "";
}

/**
 * Register every PROVIDERS entry onto a live ModelRegistry via its real
 * registerProvider(name, config). Pure aside from the registry mutation the
 * caller passes in — shared by the pre-load-providers monkey-patch
 * (./patches/pre-load-providers.ts) AND s2-agent-cli's programmatic
 * session builder (bun-apps/s2-agent/src/cli/sessions/shared.ts), so the
 * "baked provider catalog → registerProvider calls" logic exists in exactly
 * one place.
 */
export function registerAllProviders(
  registry: { registerProvider(name: string, config: unknown): void },
  env: Record<string, string | undefined> = process.env,
): void {
  for (const [name, entry] of Object.entries(PROVIDERS)) {
    const { compat: providerCompat, ...rest } = entry;
    registry.registerProvider(name, {
      ...rest,
      apiKey: resolveApiKey(entry.apiKey, env),
      models: entry.models.map((m) => ({
        ...m,
        // The SDK's extension-provider path (applyExtension) honors only
        // model-level compat, so fold the provider-level compat down here.
        compat: { ...providerCompat, ...m.compat },
        cost: ZERO_COST,
      })),
    });
  }
}

// ─── §2 Built-in default model ────────────────────────────────────────────────

/**
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
 * appropriate for this repo where these are the standard providers. Those ids
 * resolve against the catalogs in §1 (extension providers) and §4
 * (models-store seed) below.
 */
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

// ─── §3 Model-tier config seed ────────────────────────────────────────────────

/**
 * Mirrors the "glm-lmstudio" preset in s2-agent-ext-subagent/src/presets.ts and
 * the canonical ~/.pi/workflows/model-tiers.json. Seeded to that file at startup
 * by the ensure-model-tiers patch IF (and only if) the file is absent — it never
 * clobbers a user's live config. Kept as typed TS (not loose JSON) so the team's
 * preferred tier→model routing ships with the package and is version-controlled.
 *
 * NOTE: this bakes provider ids (zai/glm-*, lm-studio/qwen3.8-27b) into the shared
 * host package — appropriate for this repo where these are the standard
 * providers. The seed is idempotent + env-gated (BUN_PI_ENSURE_MODEL_TIERS=0 to
 * disable), so it never overwrites an existing file.
 */
export interface ModelTierConfig {
	tiers: { small: string; medium: string; big: string };
	capabilities: Record<string, string>;
}

export const DEFAULT_MODEL_TIER_CONFIG: ModelTierConfig = {
	tiers: { small: "zai/glm-4.7", medium: "zai/glm-5.3", big: "zai/glm-5.3" },
	capabilities: {
		vision: "lm-studio/qwen/qwen3.8-27b",
		"vision-large": "lm-studio/qwen/qwen3.8-27b",
		"vision-medium": "lm-studio/qwen/qwen3.8-27b",
		"vision-small": "lm-studio/qwen/qwen3.8-27b",
	},
};

/** Pure: serialize the config for the startup seed (ensure-model-tiers). Testable. */
export function buildModelTiersJson(config: ModelTierConfig = DEFAULT_MODEL_TIER_CONFIG): string {
	return JSON.stringify(config, null, 2) + "\n";
}

/** Pure: decide whether the ensure-seed should write. Testable. */
export function shouldEnsureModelTiers(opts: { fileExists: boolean; enabled: boolean }): boolean {
	return opts.enabled && !opts.fileExists;
}
