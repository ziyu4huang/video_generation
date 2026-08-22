/**
 * pre-load-providers — ALL baked model config for @repo/s2-agent in one file:
 *
 *   §1 PROVIDERS        — extension-provider catalog (lm-studio) + registration helpers
 *   §2 BUILTIN_MODEL_DEFAULT — the default provider/model/thinking choice
 *   §3 DEFAULT_MODEL_TIER_CONFIG — tier→model routing seed (model-tiers.json)
 *   §4 DEFAULT_MODELS_STORE — GENERATED catalog seed (models-store.json)
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
 * NOTE: this bakes provider ids (zai/glm-*, lm-studio/gemma-*) into the shared
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
		vision: "lm-studio/google/gemma-4-12b",
		"vision-large": "lm-studio/google/gemma-4-12b",
		"vision-medium": "lm-studio/google/gemma-4-12b",
		"vision-small": "lm-studio/google/gemma-4-12b",
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

// ─── §4 Models-store catalog seed — GENERATED, do not hand-edit ───────────────

/**
 * Mirrors the curated ~/.pi/agent/models-store.json (pi core's
 * FileModelsStore — the dynamically-refreshed provider catalogs for zai,
 * deepseek, huggingface). Seeded to that file at startup by the
 * ensure-models-store patch IF (and only if) the file is absent — it never
 * clobbers a live catalog, and pi's own refresh flow (etag/lastModified
 * metadata below) keeps working on top of the seed.
 *
 * Generated from the user\'s curated store on 2026-08-19 — do not hand-edit;
 * regenerate by re-exporting the live file. Typed TS so the catalog ships with
 * the package and is version-controlled.
 */
/** Compat flags as stored by pi core (shape varies per provider). */
export type StoreCompat = Record<string, unknown>;

/** One catalog model entry as stored by pi core's models-store. */
export interface StoreModel {
	id: string;
	[key: string]: unknown;
}

/** One provider's catalog entry (refresh metadata + model list). */
export interface StoreProviderEntry {
	models: StoreModel[];
	checkedAt?: number;
	etag?: string;
	lastModified?: number;
}

export type ModelsStoreData = Record<string, StoreProviderEntry>;

export const DEFAULT_MODELS_STORE: ModelsStoreData = {
 "huggingface": {
  "models": [
   {
    "id": "MiniMaxAI/MiniMax-M2",
    "name": "MiniMax-M2",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.3,
     "output": 1.2,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 204800,
    "maxTokens": 128000
   },
   {
    "id": "MiniMaxAI/MiniMax-M2.1",
    "name": "MiniMax-M2.1",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.3,
     "output": 1.2,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 204800,
    "maxTokens": 131072
   },
   {
    "id": "MiniMaxAI/MiniMax-M2.5",
    "name": "MiniMax-M2.5",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.3,
     "output": 1.2,
     "cacheRead": 0.03,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 204800,
    "maxTokens": 131072
   },
   {
    "id": "MiniMaxAI/MiniMax-M2.7",
    "name": "MiniMax-M2.7",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.3,
     "output": 1.2,
     "cacheRead": 0.06,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 204800,
    "maxTokens": 131072
   },
   {
    "id": "MiniMaxAI/MiniMax-M3",
    "name": "MiniMax-M3",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text",
     "image"
    ],
    "cost": {
     "input": 0.3,
     "output": 1.2,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 524288,
    "maxTokens": 128000
   },
   {
    "id": "Qwen/Qwen2.5-Coder-32B-Instruct",
    "name": "Qwen2.5-Coder-32B-Instruct",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": false,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.06,
     "output": 0.2,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 131072,
    "maxTokens": 8192
   },
   {
    "id": "Qwen/Qwen3-235B-A22B",
    "name": "Qwen3 235B-A22B",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.2,
     "output": 0.8,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 40960,
    "maxTokens": 16384
   },
   {
    "id": "Qwen/Qwen3-235B-A22B-Instruct-2507",
    "name": "Qwen3 235B-A22B Instruct 2507",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": false,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.855,
     "output": 2.565,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 16384
   },
   {
    "id": "Qwen/Qwen3-235B-A22B-Thinking-2507",
    "name": "Qwen3-235B-A22B-Thinking-2507",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.3,
     "output": 3,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 131072
   },
   {
    "id": "Qwen/Qwen3-30B-A3B",
    "name": "Qwen3 30B A3B",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.12,
     "output": 0.5,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 40960,
    "maxTokens": 16384
   },
   {
    "id": "Qwen/Qwen3-32B",
    "name": "Qwen3 32B",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.29,
     "output": 0.59,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 131072,
    "maxTokens": 16384
   },
   {
    "id": "Qwen/Qwen3-Coder-30B-A3B-Instruct",
    "name": "Qwen3-Coder 30B-A3B Instruct",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": false,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.07,
     "output": 0.26,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 65536
   },
   {
    "id": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
    "name": "Qwen3-Coder-480B-A35B-Instruct",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": false,
    "input": [
     "text"
    ],
    "cost": {
     "input": 2,
     "output": 2,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 66536
   },
   {
    "id": "Qwen/Qwen3-Coder-Next",
    "name": "Qwen3-Coder-Next",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": false,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.2,
     "output": 1.5,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 65536
   },
   {
    "id": "Qwen/Qwen3-Next-80B-A3B-Instruct",
    "name": "Qwen3-Next-80B-A3B-Instruct",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": false,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.25,
     "output": 1,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 66536
   },
   {
    "id": "Qwen/Qwen3-Next-80B-A3B-Thinking",
    "name": "Qwen3-Next-80B-A3B-Thinking",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": false,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.3,
     "output": 2,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 131072
   },
   {
    "id": "Qwen/Qwen3-VL-235B-A22B-Instruct",
    "name": "Qwen3 VL 235B A22B Instruct",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": false,
    "input": [
     "text",
     "image"
    ],
    "cost": {
     "input": 0.3,
     "output": 1.5,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 131072,
    "maxTokens": 32768
   },
   {
    "id": "Qwen/Qwen3-VL-235B-A22B-Thinking",
    "name": "Qwen3 VL 235B A22B Thinking",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text",
     "image"
    ],
    "cost": {
     "input": 0.98,
     "output": 3.95,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 131072,
    "maxTokens": 32768,
    "thinkingLevelMap": {
     "off": null,
     "minimal": null,
     "low": "low",
     "medium": "medium",
     "high": "high",
     "xhigh": null,
     "max": null
    }
   },
   {
    "id": "Qwen/Qwen3.5-122B-A10B",
    "name": "Qwen3.5 122B-A10B",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text",
     "image"
    ],
    "cost": {
     "input": 0.4,
     "output": 3.2,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 65536
   },
   {
    "id": "Qwen/Qwen3.5-27B",
    "name": "Qwen3.5 27B",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text",
     "image"
    ],
    "cost": {
     "input": 0.3,
     "output": 2.4,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 65536
   },
   {
    "id": "Qwen/Qwen3.5-35B-A3B",
    "name": "Qwen3.5 35B-A3B",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text",
     "image"
    ],
    "cost": {
     "input": 0.25,
     "output": 2,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 65536
   },
   {
    "id": "Qwen/Qwen3.5-397B-A17B",
    "name": "Qwen3.5-397B-A17B",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text",
     "image"
    ],
    "cost": {
     "input": 0.6,
     "output": 3.6,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 32768,
    "thinkingLevelMap": {
     "off": "none",
     "minimal": null,
     "low": "low",
     "medium": "medium",
     "high": "high",
     "xhigh": null,
     "max": null
    }
   },
   {
    "id": "Qwen/Qwen3.5-9B",
    "name": "Qwen3.5 9B",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text",
     "image"
    ],
    "cost": {
     "input": 0.17,
     "output": 0.25,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 65536
   },
   {
    "id": "Qwen/Qwen3.6-27B",
    "name": "Qwen3.6 27B",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text",
     "image"
    ],
    "cost": {
     "input": 0.47,
     "output": 3.19,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 65536
   },
   {
    "id": "Qwen/Qwen3.6-35B-A3B",
    "name": "Qwen3.6 35B-A3B",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text",
     "image"
    ],
    "cost": {
     "input": 0.15,
     "output": 0.95,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 65536
   },
   {
    "id": "Qwen/Qwen3.8-2.4T-A95B",
    "name": "Qwen3.8 2.4T A95B",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 2.5,
     "output": 6.25,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 131072,
    "thinkingLevelMap": {
     "off": null,
     "minimal": null,
     "low": "low",
     "medium": "medium",
     "high": null,
     "xhigh": "xhigh",
     "max": null
    }
   },
   {
    "id": "XiaomiMiMo/MiMo-V2-Flash",
    "name": "MiMo-V2-Flash",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.1,
     "output": 0.3,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 4096
   },
   {
    "id": "XiaomiMiMo/MiMo-V2.5",
    "name": "MiMo-V2.5",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.4,
     "output": 2,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 131072,
    "thinkingLevelMap": {
     "off": "none",
     "minimal": null,
     "low": "low",
     "medium": "medium",
     "high": "high",
     "xhigh": "xhigh",
     "max": null
    }
   },
   {
    "id": "XiaomiMiMo/MiMo-V2.5-Pro",
    "name": "MiMo-V2.5-Pro",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 1,
     "output": 3,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 1048576,
    "maxTokens": 131072,
    "thinkingLevelMap": {
     "off": "none",
     "minimal": null,
     "low": "low",
     "medium": "medium",
     "high": "high",
     "xhigh": "xhigh",
     "max": null
    }
   },
   {
    "id": "deepseek-ai/DeepSeek-R1",
    "name": "DeepSeek-R1",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.7,
     "output": 2.5,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 64000,
    "maxTokens": 32768
   },
   {
    "id": "deepseek-ai/DeepSeek-R1-0528",
    "name": "DeepSeek-R1-0528",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 3,
     "output": 5,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 163840,
    "maxTokens": 163840
   },
   {
    "id": "deepseek-ai/DeepSeek-V3",
    "name": "DeepSeek-V3",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": false,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.4,
     "output": 1.3,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 64000,
    "maxTokens": 8192
   },
   {
    "id": "deepseek-ai/DeepSeek-V3-0324",
    "name": "DeepSeek V3 0324",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": false,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.27,
     "output": 1.12,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 163840,
    "maxTokens": 163840
   },
   {
    "id": "deepseek-ai/DeepSeek-V3.1",
    "name": "DeepSeek-V3.1",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.27,
     "output": 1,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 131072,
    "maxTokens": 8192
   },
   {
    "id": "deepseek-ai/DeepSeek-V3.2",
    "name": "DeepSeek-V3.2",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.28,
     "output": 0.4,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 163840,
    "maxTokens": 65536
   },
   {
    "id": "deepseek-ai/DeepSeek-V4-Flash",
    "name": "DeepSeek V4 Flash",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.14,
     "output": 0.28,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 1048576,
    "maxTokens": 384000
   },
   {
    "id": "deepseek-ai/DeepSeek-V4-Flash-0731",
    "name": "DeepSeek V4 Flash 0731",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.14,
     "output": 0.28,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 1048576,
    "maxTokens": 384000,
    "thinkingLevelMap": {
     "off": null,
     "minimal": null,
     "low": null,
     "medium": null,
     "high": "high",
     "xhigh": null,
     "max": "max"
    }
   },
   {
    "id": "deepseek-ai/DeepSeek-V4-Pro",
    "name": "DeepSeek V4 Pro",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.435,
     "output": 0.87,
     "cacheRead": 0.003625,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 1048576,
    "maxTokens": 393216,
    "thinkingLevelMap": {
     "off": null,
     "minimal": null,
     "low": null,
     "medium": null,
     "high": "high",
     "xhigh": null,
     "max": null
    }
   },
   {
    "id": "deepseek-ai/DeepSeek-V4-Pro-0813",
    "name": "DeepSeek V4 Pro 0813",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 1.32,
     "output": 3.96,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 1000000,
    "maxTokens": 384000,
    "thinkingLevelMap": {
     "off": null,
     "minimal": null,
     "low": "low",
     "medium": null,
     "high": "high",
     "xhigh": null,
     "max": "max"
    }
   },
   {
    "id": "google/gemma-4-26B-A4B-it",
    "name": "Gemma 4 26B A4B IT",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text",
     "image"
    ],
    "cost": {
     "input": 0.13,
     "output": 0.4,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 32768
   },
   {
    "id": "google/gemma-4-31B-it",
    "name": "Gemma 4 31B IT",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text",
     "image"
    ],
    "cost": {
     "input": 0.14,
     "output": 0.4,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 32768
   },
   {
    "id": "meta-llama/Llama-3.1-8B-Instruct",
    "name": "Llama-3.1-8B-Instruct",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": false,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.06,
     "output": 0.06,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 131072,
    "maxTokens": 4096
   },
   {
    "id": "meta-llama/Llama-3.3-70B-Instruct",
    "name": "Llama-3.3-70B-Instruct",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": false,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.59,
     "output": 0.79,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 131072,
    "maxTokens": 4096
   },
   {
    "id": "moonshotai/Kimi-K2-Instruct",
    "name": "Kimi-K2-Instruct",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": false,
    "input": [
     "text"
    ],
    "cost": {
     "input": 1,
     "output": 3,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 131072,
    "maxTokens": 16384
   },
   {
    "id": "moonshotai/Kimi-K2-Instruct-0905",
    "name": "Kimi-K2-Instruct-0905",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": false,
    "input": [
     "text"
    ],
    "cost": {
     "input": 1,
     "output": 3,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 16384
   },
   {
    "id": "moonshotai/Kimi-K2-Thinking",
    "name": "Kimi-K2-Thinking",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.6,
     "output": 2.5,
     "cacheRead": 0.15,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 262144
   },
   {
    "id": "moonshotai/Kimi-K2.5",
    "name": "Kimi-K2.5",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text",
     "image"
    ],
    "cost": {
     "input": 0.6,
     "output": 3,
     "cacheRead": 0.1,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 262144
   },
   {
    "id": "moonshotai/Kimi-K2.6",
    "name": "Kimi-K2.6",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text",
     "image"
    ],
    "cost": {
     "input": 0.95,
     "output": 4,
     "cacheRead": 0.16,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 262144
   },
   {
    "id": "moonshotai/Kimi-K2.7-Code",
    "name": "Kimi K2.7 Code",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text",
     "image"
    ],
    "cost": {
     "input": 0.95,
     "output": 4,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 262144
   },
   {
    "id": "moonshotai/Kimi-K3",
    "name": "Kimi K3",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text",
     "image"
    ],
    "cost": {
     "input": 3,
     "output": 15,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 1000000,
    "maxTokens": 131072,
    "thinkingLevelMap": {
     "off": null,
     "minimal": null,
     "low": "low",
     "medium": null,
     "high": "high",
     "xhigh": null,
     "max": "max"
    }
   },
   {
    "id": "openai/gpt-oss-120b",
    "name": "GPT OSS 120B",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.25,
     "output": 0.69,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 131072,
    "maxTokens": 32768,
    "thinkingLevelMap": {
     "off": null,
     "minimal": null,
     "low": "low",
     "medium": "medium",
     "high": "high",
     "xhigh": null,
     "max": null
    }
   },
   {
    "id": "openai/gpt-oss-20b",
    "name": "GPT OSS 20B",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.1,
     "output": 0.5,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 131072,
    "maxTokens": 32768,
    "thinkingLevelMap": {
     "off": null,
     "minimal": null,
     "low": "low",
     "medium": "medium",
     "high": "high",
     "xhigh": null,
     "max": null
    }
   },
   {
    "id": "stepfun-ai/Step-3.5-Flash",
    "name": "Step 3.5 Flash",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.1,
     "output": 0.3,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 256000
   },
   {
    "id": "stepfun-ai/Step-3.7-Flash",
    "name": "Step 3.7 Flash",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text",
     "image"
    ],
    "cost": {
     "input": 0.2,
     "output": 1.15,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 256000,
    "thinkingLevelMap": {
     "off": null,
     "minimal": null,
     "low": "low",
     "medium": "medium",
     "high": "high",
     "xhigh": null,
     "max": null
    }
   },
   {
    "id": "tencent/Hy3",
    "name": "Hy3",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.14,
     "output": 0.58,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 64000,
    "thinkingLevelMap": {
     "off": "none",
     "minimal": null,
     "low": "low",
     "medium": null,
     "high": "high",
     "xhigh": null,
     "max": null
    }
   },
   {
    "id": "thinkingmachines/Inkling",
    "name": "Inkling",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text",
     "image"
    ],
    "cost": {
     "input": 1,
     "output": 4.05,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 1048576,
    "maxTokens": 1048576,
    "thinkingLevelMap": {
     "off": null,
     "minimal": null,
     "low": "low",
     "medium": "medium",
     "high": "high",
     "xhigh": null,
     "max": null
    }
   },
   {
    "id": "thinkingmachines/Inkling-Small",
    "name": "Inkling Small",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text",
     "image"
    ],
    "cost": {
     "input": 0.5,
     "output": 1.2,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 524288,
    "maxTokens": 1048576
   },
   {
    "id": "zai-org/GLM-4.5",
    "name": "GLM-4.5",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.6,
     "output": 2.2,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 131072,
    "maxTokens": 98304
   },
   {
    "id": "zai-org/GLM-4.5-Air",
    "name": "GLM-4.5-Air",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.13,
     "output": 0.85,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 131072,
    "maxTokens": 98304
   },
   {
    "id": "zai-org/GLM-4.5V",
    "name": "GLM-4.5V",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text",
     "image"
    ],
    "cost": {
     "input": 0.6,
     "output": 1.8,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 65536,
    "maxTokens": 16384
   },
   {
    "id": "zai-org/GLM-4.6",
    "name": "GLM-4.6",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.55,
     "output": 2.2,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 204800,
    "maxTokens": 131072
   },
   {
    "id": "zai-org/GLM-4.7",
    "name": "GLM-4.7",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.6,
     "output": 2.2,
     "cacheRead": 0.11,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 204800,
    "maxTokens": 131072
   },
   {
    "id": "zai-org/GLM-4.7-Flash",
    "name": "GLM-4.7-Flash",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0,
     "output": 0,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 200000,
    "maxTokens": 128000
   },
   {
    "id": "zai-org/GLM-5",
    "name": "GLM-5",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 1,
     "output": 3.2,
     "cacheRead": 0.2,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 202752,
    "maxTokens": 131072
   },
   {
    "id": "zai-org/GLM-5.1",
    "name": "GLM-5.1",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 1,
     "output": 3.2,
     "cacheRead": 0.2,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 202752,
    "maxTokens": 131072
   },
   {
    "id": "zai-org/GLM-5.2",
    "name": "GLM-5.2",
    "api": "openai-completions",
    "provider": "huggingface",
    "baseUrl": "https://router.huggingface.co/v1",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 1.4,
     "output": 4.4,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsDeveloperRole": false
    },
    "contextWindow": 262144,
    "maxTokens": 131072
   }
  ],
  "checkedAt": 1787146746671,
  "lastModified": 1787050116000,
  "etag": "W/\"517d343abfa162de017e31e922afe96e\""
 },
 "deepseek": {
  "models": [
   {
    "id": "deepseek-v4-flash",
    "name": "DeepSeek V4 Flash",
    "api": "openai-completions",
    "baseUrl": "https://api.deepseek.com",
    "provider": "deepseek",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.14,
     "output": 0.28,
     "cacheRead": 0.0028,
     "cacheWrite": 0
    },
    "contextWindow": 1000000,
    "maxTokens": 384000,
    "compat": {
     "supportsStore": false,
     "supportsDeveloperRole": false,
     "maxTokensField": "max_tokens",
     "requiresReasoningContentOnAssistantMessages": true,
     "thinkingFormat": "deepseek"
    },
    "thinkingLevelMap": {
     "minimal": null,
     "low": "low",
     "medium": null,
     "high": "high",
     "max": "max"
    }
   },
   {
    "id": "deepseek-v4-pro",
    "name": "DeepSeek V4 Pro",
    "api": "openai-completions",
    "baseUrl": "https://api.deepseek.com",
    "provider": "deepseek",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.435,
     "output": 0.87,
     "cacheRead": 0.003625,
     "cacheWrite": 0
    },
    "contextWindow": 1000000,
    "maxTokens": 384000,
    "compat": {
     "supportsStore": false,
     "supportsDeveloperRole": false,
     "maxTokensField": "max_tokens",
     "requiresReasoningContentOnAssistantMessages": true,
     "thinkingFormat": "deepseek"
    },
    "thinkingLevelMap": {
     "minimal": null,
     "low": null,
     "medium": null,
     "high": "high",
     "max": "max"
    }
   }
  ],
  "checkedAt": 1787146741903,
  "lastModified": 1786444602000,
  "etag": "W/\"c856e605b796f2df5d2cc4d7c20336f5\""
 },
 "zai": {
  "models": [
   {
    "id": "glm-4.7",
    "name": "GLM-4.7",
    "api": "openai-completions",
    "provider": "zai",
    "baseUrl": "https://api.z.ai/api/coding/paas/v4",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 0.6,
     "output": 2.2,
     "cacheRead": 0.11,
     "cacheWrite": 0
    },
    "compat": {
     "supportsStore": false,
     "supportsDeveloperRole": false,
     "supportsReasoningEffort": false,
     "maxTokensField": "max_tokens",
     "thinkingFormat": "zai",
     "zaiToolStream": true
    },
    "contextWindow": 204800,
    "maxTokens": 131072
   },
   {
    "id": "glm-5-turbo",
    "name": "GLM-5-Turbo",
    "api": "openai-completions",
    "provider": "zai",
    "baseUrl": "https://api.z.ai/api/coding/paas/v4",
    "reasoning": true,
    "input": [
     "text"
    ],
    "cost": {
     "input": 1.2,
     "output": 4,
     "cacheRead": 0.24,
     "cacheWrite": 0
    },
    "compat": {
     "supportsStore": false,
     "supportsDeveloperRole": false,
     "supportsReasoningEffort": false,
     "maxTokensField": "max_tokens",
     "thinkingFormat": "zai",
     "zaiToolStream": true
    },
    "contextWindow": 200000,
    "maxTokens": 131072
   },
   {
    "id": "glm-5.2",
    "name": "GLM-5.2",
    "api": "openai-completions",
    "provider": "zai",
    "baseUrl": "https://api.z.ai/api/coding/paas/v4",
    "reasoning": true,
    "thinkingLevelMap": {
     "off": "none",
     "minimal": null,
     "low": null,
     "medium": null,
     "high": "high",
     "xhigh": null,
     "max": "max"
    },
    "input": [
     "text"
    ],
    "cost": {
     "input": 1.4,
     "output": 4.4,
     "cacheRead": 0.26,
     "cacheWrite": 0
    },
    "compat": {
     "supportsStore": false,
     "supportsDeveloperRole": false,
     "supportsReasoningEffort": true,
     "maxTokensField": "max_tokens",
     "thinkingFormat": "zai",
     "zaiToolStream": true
    },
    "contextWindow": 1000000,
    "maxTokens": 131072
   },
   {
    "id": "glm-5.2-highspeed",
    "name": "GLM-5.2 Highspeed",
    "api": "openai-completions",
    "provider": "zai",
    "baseUrl": "https://api.z.ai/api/coding/paas/v4",
    "reasoning": true,
    "thinkingLevelMap": {
     "off": "none",
     "minimal": null,
     "low": null,
     "medium": null,
     "high": "high",
     "xhigh": null,
     "max": "max"
    },
    "input": [
     "text"
    ],
    "cost": {
     "input": 0,
     "output": 0,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsStore": false,
     "supportsDeveloperRole": false,
     "supportsReasoningEffort": true,
     "maxTokensField": "max_tokens",
     "thinkingFormat": "zai",
     "zaiToolStream": true
    },
    "contextWindow": 1000000,
    "maxTokens": 131072
   },
   {
    "id": "glm-5.3",
    "name": "GLM-5.3",
    "api": "openai-completions",
    "provider": "zai",
    "baseUrl": "https://api.z.ai/api/coding/paas/v4",
    "reasoning": true,
    "thinkingLevelMap": {
     "off": null,
     "minimal": null,
     "low": "low",
     "medium": null,
     "high": "high",
     "xhigh": null,
     "max": "max"
    },
    "input": [
     "text"
    ],
    "cost": {
     "input": 0,
     "output": 0,
     "cacheRead": 0,
     "cacheWrite": 0
    },
    "compat": {
     "supportsStore": false,
     "supportsDeveloperRole": false,
     "supportsReasoningEffort": true,
     "maxTokensField": "max_tokens",
     "thinkingFormat": "zai",
     "zaiToolStream": true
    },
    "contextWindow": 1000000,
    "maxTokens": 131072
   }
  ],
  "checkedAt": 1787146741740,
  "lastModified": 1787141960000,
  "etag": "W/\"4caeb048c05fb4882a87e1e9c156f9e7\""
 }
};

/** Pure: serialize the catalog for the seed write. Testable. */
export function buildModelsStoreJson(
	data: ModelsStoreData = DEFAULT_MODELS_STORE,
): string {
	return JSON.stringify(data, null, 2) + "\n";
}

/** Pure: decide whether the ensure-seed should write. Testable. */
export function shouldEnsureModelsStore(opts: {
	fileExists: boolean;
	enabled: boolean;
}): boolean {
	return opts.enabled && !opts.fileExists;
}
