/**
 * pre-load-providers — the baked LLM provider catalog + pure helpers to
 * register it onto a ModelRegistry.
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
 * registerAllProviders from anywhere (including pi-agent-cli, via `@repo/pi-agent`)
 * must never monkey-patch anything. The actual ModelRegistry.prototype.loadModels
 * patch lives in `./patches/pre-load-providers-patch.ts` and is applied ONLY via
 * applyPatches() (env-gated, main()-oriented). A prior version patched the
 * prototype right here at module scope, which meant ANY import of this file —
 * even just `{ PROVIDERS }` — applied the patch as an ES-module evaluation side
 * effect, double-registering every provider for pi-agent-cli's programmatic
 * session builder (which explicitly imports PROVIDERS to AVOID that patch; see
 * bun-apps/pi-agent-cli/src/sessions/shared.ts). Keep it that way.
 */

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
        id: "google/gemma-4-12b-qat",
        name: "Gemma 4 12B (LM Studio)",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200_000,
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

/** Resolve an ApiKey spec: a literal string, or {env} → process.env ("" if unset). */
export function resolveApiKey(key: ApiKey, env: Record<string, string | undefined> = process.env): string {
  if (typeof key === "string") return key;
  return env[key.env] ?? "";
}

/**
 * Register every PROVIDERS entry onto a live ModelRegistry via its real
 * registerProvider(name, config). Pure aside from the registry mutation the
 * caller passes in — shared by the pre-load-providers monkey-patch
 * (./patches/pre-load-providers-patch.ts) AND pi-agent-cli's programmatic
 * session builder (bun-apps/pi-agent-cli/src/sessions/shared.ts), so the
 * "baked provider catalog → registerProvider calls" logic exists in exactly
 * one place.
 */
export function registerAllProviders(
  registry: { registerProvider(name: string, config: unknown): void },
  env: Record<string, string | undefined> = process.env,
): void {
  for (const [name, entry] of Object.entries(PROVIDERS)) {
    registry.registerProvider(name, {
      ...entry,
      apiKey: resolveApiKey(entry.apiKey, env),
      models: entry.models.map((m) => ({ ...m, cost: ZERO_COST })),
    });
  }
}
