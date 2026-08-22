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
    // The single local LM Studio model this repo targets. Previously the
    // catalog listed several (gemma-4-26b/31b-qat, qwen3.6-27b-mtp,
    // qwen3-vl-4b); they were consolidated to google/gemma-4-12b — see the
    // "local model" convention across s2-agent-ext-*.
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
