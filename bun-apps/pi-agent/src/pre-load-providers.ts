/**
 * pre-load-providers — inject custom LLM providers into pi's ModelRegistry.
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
 * HOW IT WORKS (internals)
 * ------------------------
 * ModelRegistry constructor calls the private loadModels(), not refresh().
 * We wrap loadModels() so that after the built-in catalog loads, we call the
 * real registerProvider() for every entry in PROVIDERS. registerProvider() stores
 * the config in registeredProviders, so any later refresh() replays it automatically.
 */
import { ModelRegistry } from "@earendil-works/pi-coding-agent";

// ─── Provider config ──────────────────────────────────────────────────────────

export type ApiKey = string | { env: string };

interface ModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  compat?: { supportsDeveloperRole?: boolean; supportsReasoningEffort?: boolean };
}

interface ProviderEntry {
  baseUrl: string;
  api: string;
  apiKey: ApiKey;
  models: ModelEntry[];
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const PROVIDERS: Record<string, ProviderEntry> = {

  "lm-studio": {
    baseUrl: "http://localhost:1234/v1",
    api: "openai-completions",
    apiKey: "lm-studio",
    models: [
      {
        id: "google/gemma-4-26b-a4b-qat",
        name: "Gemma 4 26B (LM Studio)",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128_000,
        maxTokens: 16_384,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      },
      {
        id: "google/gemma-4-31b-qat",
        name: "Gemma 4 31B (LM Studio)",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128_000,
        maxTokens: 16_384,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      },
      {
        id: "qwen/qwen3-vl-4b",
        name: "Qwen3 VL 4B (LM Studio)",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 131_072,
        maxTokens: 16_384,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
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

// ─── Patch ────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Proto = ModelRegistry.prototype as any;

// Capture real methods before any other patch can touch them.
const _realLoadModels = Proto.loadModels as (this: unknown) => void;
const _realRegisterProvider = Proto.registerProvider as (
  this: unknown,
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
) => void;

/** Resolve an ApiKey spec: a literal string, or {env} → process.env ("" if unset). */
export function resolveApiKey(key: ApiKey, env: Record<string, string | undefined> = process.env): string {
  if (typeof key === "string") return key;
  return env[key.env] ?? "";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
Proto.loadModels = function (this: any) {
  _realLoadModels.call(this);
  for (const [name, entry] of Object.entries(PROVIDERS)) {
    _realRegisterProvider.call(this, name, {
      ...entry,
      apiKey: resolveApiKey(entry.apiKey),
      models: entry.models.map((m) => ({ ...m, cost: ZERO_COST })),
    });
  }
};

export const preLoadProvidersPatchApplied = true;
