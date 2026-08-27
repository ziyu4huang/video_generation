/**
 * pre-load-providers — ALL baked model config for @repo/s2-agent in one file:
 * (single-catalog invariant: `ADR-s2-agent-0005`)
 *
 *   §1 PROVIDERS        — extension-provider catalog (lm-studio) + registration helpers
 *   §2 BUILTIN_MODEL_DEFAULT — the default provider/model/thinking choice
 *   §3 DEFAULT_MODEL_TIER_CONFIG — tier→model routing seed (model-tiers.json)
 *   §4 EMBEDDING_CONFIG — baked embedding endpoint + model (knowledge layer)
 *
 * RETIRED 2026-08-22: the OLD §4 DEFAULT_MODELS_STORE (models-store.json
 * seed) was removed — pi 0.84.2's builtin catalog (pi-ai models.generated.js)
 * already ships zai/deepseek/huggingface, so seeding ~/.pi/agent/models-store.json was
 * redundant; the file is now neither seeded nor persisted (see
 * patches/in-memory-models-store.ts). Every LLM-related setting — chat
 * providers, default model, tier routing, vision capability lanes, AND the
 * embedding model — is authored in THIS file with no config imports.
 *
 * HOW TO ADD A PROVIDER
 * ---------------------
 * Add an entry to PROVIDERS below. Run `bun src/cli.ts --list-models` to verify.
 * No other file needs to change. Model-catalog changes follow the devops skill
 * `s2-agent-model-catalog-update` (bun-apps/s2-agent-ext-devops/skills/) —
 * commonly used for updating s2-agent's model settings in this file. Warning:
 * registering under a provider id the baked catalog already has (deepseek, zai)
 * REPLACES its baked model list — re-list every baked model or it vanishes.
 *
 * API KEY
 * -------
 *   apiKey: "literal-string"         — hardcode (OK for local servers with fake keys)
 *   apiKey: { env: "MY_API_KEY" }   — read from environment variable at runtime
 *
 * SIDE-EFFECT-FREE BY DESIGN
 * ---------------------------
 * This module has NO top-level side effects and NO config imports — importing
 * PROVIDERS / resolveApiKey / registerAllProviders from anywhere (including
 * s2-agent-cli, via `@repo/s2-agent`)
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
  // openai-completions adapter knobs — MOSTLY the ones pi-ai's detectCompat()
  // infers from provider id + baseUrl, pinned explicitly here so the extension
  // registration is stable across pi-ai upgrades (see getCompat() /
  // detectCompat() in pi-ai dist/api/openai-completions.js). EXCEPTION:
  // zaiToolStream is NOT inferred — detectCompat() hardcodes it false, so a
  // pinned true is the one entry a "redundant compat" cleanup must never drop.
  supportsStore?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  requiresReasoningContentOnAssistantMessages?: boolean;
  thinkingFormat?: "openai" | "deepseek" | "zai" | "qwen" | string;
  /**
   * pi-ai zai adapter knob: streamed tool-call deltas. NOT re-derivable —
   * detectCompat() hardcodes false; the pinned true is load-bearing for the
   * repo's DEFAULT provider (zai/glm-5.3). Guarded by the folded-compat
   * test in pre-load-providers.test.ts.
   */
  zaiToolStream?: boolean;
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
  /**
   * pi effort level → provider-specific effort string (or null = level
   * unsupported). Same shape as pi-ai's baked thinkingLevelMap; passed
   * through unmodified by the extension-provider path.
   */
  thinkingLevelMap?: Record<string, string | null>;
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
//
// ─── HOW TO SWITCH LM-STUDIO THINKING ON/OFF (study note, measured) ────────
//
// The ONE knob that works on this server's /v1/chat/completions is the
// TOP-LEVEL STRING `reasoning_effort`. The API validates it against OpenAI's
// enum — measured 2026-08-24, the server 400s anything else:
//   "Invalid 'reasoning_effort' value: 'on'. Supported values:
//    none, minimal, low, medium, high, xhigh."
// ('on'/'off' are LM Studio GUI-side "Reasoning setting" names — NOT wire
// values; a `[WARN] Reasoning setting 'high' is not supported … Supported
// settings: 'on', 'off'` in the server log is the GUI layer mapping a wire
// effort onto the model's on/off switch, then falling back to 'on'.)
//
// OFF = `reasoning_effort: "none"` — the ONLY reliable off, honored by both
// installed VLMs (measured 2026-08-24, one-sentence ask, max_tokens=300..500):
//   • google/gemma-4-12b   baseline → 619 chars reasoning_content, ~4.5s;
//     `"none"` → reasoning_len **0**, answer directly in content. Same for
//   • qwen/qwen3.8-27b     baseline → 137 chars; `"none"` → **0**.
//
// Shapes that DO NOT work (measured 2026-08-23 on qwen, single trivial ask):
//   ✗ `reasoning: { effort: "none" }` (nested object — the wrong shape; the
//     2026-08-23 "no no-think achievable" conclusion was this artifact)
//     → 8.7s, 110 reasoning tokens
//   ✗ `chat_template_kwargs.enable_thinking: false` → 12.9s, 183 tokens
//     (ignored — it reasons MORE)
//   ✗ top-level `enable_thinking: false` → 4.9s, 49 tokens (ignored)
// Also NOT a disable signal: a `reasoning: false` flag in THIS catalog — that
// is host metadata only (pi treats the model as non-reasoning and stops
// sending reasoning params; the server keeps its own thinking-on default).
//
// ON = any non-none enum value. Per-model vocab (server-log WARNs, 2026-08-24):
//   • gemma-4-12b understands ONLY its on/off switch — every non-none value
//     maps to "on" (a `low` request logs a WARN then reasons). No gradations.
//   • qwen3.8-27b supports `low`/`medium`/`xhigh` natively; `high` warns and
//     falls back to on — map high → "xhigh" (the entries below do).
//
// HOW PI EMITS IT (openai-completions adapter, node_modules/@earendil-works/
// pi-ai/dist/api/openai-completions.js): a top-level `reasoning_effort` is
// sent only when `compat.supportsReasoningEffort` is true — the provider
// level below pins it FALSE, so a model opts in via PER-MODEL
// `compat: { supportsReasoningEffort: true }` (merged on top). The value is
// `thinkingLevelMap[<level>] ?? <level>`; with thinking OFF the adapter sends
// `thinkingLevelMap.off`. So the full no-think recipe for an LM Studio model:
//
//   1. per-model `compat: { supportsReasoningEffort: true }`
//   2. per-model `thinkingLevelMap: { off: "none", … }`
//   3. run it thinking-off: `--thinking off` (PROVEN reliable, measured
//      2026-08-24: session record shows level=off, answer has NO thinking
//      part), or a caller default of off. CAVEAT on the spec suffix
//      (`provider/id:off` in capabilities/`--model`): pi's model-resolver
//      (resolveCliModel) and s2-agent's resolveLLM BOTH parse the suffix
//      correctly — but the sessions created from a `--model <id>:off -p` CLI
//      run still recorded thinkingLevel HIGH and emitted REAL reasoning
//      content (measured 2026-08-24, session JSONL + assistant
//      `thinking` parts — the old `-nothink` sessions record `off`
//      faithfully, so the record is trustworthy). The suffix was
//      parsed-then-dropped somewhere in the session-creation handoff;
//      until that handoff bug is found, treat `--thinking off` as the
//      reliable no-think switch on the CLI path. Capability specs
//      (`:off` in §3 / buildMainSpec) were NOT re-verified end-to-end — same
//      risk applies.
//
// Thinking ON = run it with a thinking level (spec `:high`, `--thinking
// high`); the map translates pi levels to values the model actually speaks
// (see each entry). Both gemma and qwen entries below carry this wiring, so
// any lane can be flipped on/off from config in this one file.
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
        // maxTokens is a SHARED budget (reasoning + answer): a small cap
        // truncates the reply to an empty "length" stop — the "strange
        // message" symptom (session 2026-08-22: output=16383, reasoning=5459,
        // content=""). 65_536 keeps headroom for reasoning while staying
        // inside the model's real 262_144 context window.
        maxTokens: 65_536,
        // NO-THINK WIRED (see the study note above LM_STUDIO_COMPAT):
        // measured 2026-08-24, `reasoning_effort:"none"` is honored on this
        // hub-served key (reasoning_len 0, direct content, ~4.5s vs 619
        // chars of reasoning burn without it). This is the vision default —
        // §3's capability specs pin `:off`, which the adapter maps to
        // "none". gemma-4-12b has NO effort gradations (its model-level
        // switch is on/off only): every non-none pi level lands on the
        // model's "on" — low/medium pass natively as wire values, the pi
        // extremes clamp to "xhigh" (the enum's top) to stay request-valid.
        compat: { supportsReasoningEffort: true },
        thinkingLevelMap: {
          off: "none",
          minimal: "none",
          low: "low",
          medium: "medium",
          high: "high",
          max: "xhigh",
          xhigh: "xhigh",
        },
      },
      {
        // BENCHMARKED LANE (2026-08-24, this machine): the same gemma-4-12b
        // served from the QAT GGUF variant — a DISTINCT id in LM Studio's
        // /v1/models (`google/gemma-4-12b-qat`), loaded from
        // .lmstudio/models/lmstudio-community/gemma-4-12B-it-QAT-GGUF. Same
        // no-think wiring as the base entry — measured honored:
        //   • text ask, reasoning_effort:"none" → 0 reasoning tokens, 0.36s
        //   • image ask (1px PNG) → direct answer, 0 reasoning tokens, 0.51s
        // COST vs the base entry (the reason the capability specs do NOT use
        // this lane): 9,018-token prefill → 8.4s (~1.07K tok/s) vs 4.9s
        // (~1.84K tok/s) on `google/gemma-4-12b` — ~1.7× slower per token, so
        // on the agent's ~40-50K-token prompts this lane is tens of seconds
        // worse per turn for the same output. Tiny asks are indistinguishable
        // (<0.4s both). Prefer the base entry for anything latency-relevant;
        // this lane exists for when the QAT weights' other properties matter.
        // ENGINE note (user Q, 2026-08-24): the QAT lane is llama.cpp (GGUF),
        // while `google/gemma-4-12b` is MLX-4bit — LM Studio serves ONE
        // engine per GPU, so switching lanes costs a full model unload+load.
        // Agent e2e (trivial ask, same machine, 2026-08-24 pass 1; step
        // start times UTC from the session JSONL):
        //   base   fresh 33.5s @05:12Z (idle-unloaded; main.log load dump
        //          at 05:12:37Z) | repeated 6.7s @05:13:16Z / 05:15:36Z
        //   qat    engine-switch 77.4s @05:13:50Z | repeated 28.9s @05:15:07Z
        // (Measured split: fresh prompt ~21-33s prefill at ~1.3K tok/s on
        // ~30K-token agent prompts + engine load 10-45s; same-lane
        // repeat ≈2-7s once the server's prompt KV cache serves the
        // identical prefix. The llama.cpp lane showed NO cross-run cache:
        // 26s on repeat.) Correctness is uncompromised (same
        // /v1/chat/completions; none-honored; vision OK — image ask 0.51s,
        // 0 reasoning tokens); the draw is QAT quality-per-bit, paid in
        // latency + engine-switch. Guidance: pick ONE lane per session and
        // keep the server's idle-load off so the chosen engine stays
        // resident; mixing lanes per-run pays the full reload every time.
        // `none` is the only effort verified HERE (higher levels assumed same
        // on/off server behavior as the base — same model family, untested).
        id: "google/gemma-4-12b-qat",
        name: "Gemma 4 12B QAT (LM Studio)",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 65_536,
        compat: { supportsReasoningEffort: true },
        thinkingLevelMap: {
          off: "none",
          minimal: "none",
          low: "low",
          medium: "medium",
          high: "high",
          max: "xhigh",
          xhigh: "xhigh",
        },
      },
      {
        id: "qwen/qwen3.8-27b",
        name: "Qwen 3.8 27B (LM Studio)",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200_000,
        // Same shared maxTokens budget as gemma-4-12b (reasoning + answer),
        // and the same no-think wiring (same model variant family, operator
        // directive 2026-08-24): measured, top-level `reasoning_effort:"none"`
        // drops qwen from 137 chars of reasoning_content to 0 (the
        // 2026-08-23 "no no-think achievable" battery tested only the WRONG
        // shapes — see the study note above LM_STUDIO_COMPAT). qwen's native
        // efforts are low/medium/xhigh — `high` warns and falls back to on,
        // so high/max/xhigh all map to "xhigh". Kept as the fallback vision
        // lane; §3 points the capability at gemma.
        maxTokens: 65_536,
        compat: { supportsReasoningEffort: true },
        thinkingLevelMap: {
          off: "none",
          minimal: "none",
          low: "low",
          medium: "medium",
          high: "xhigh",
          max: "xhigh",
          xhigh: "xhigh",
        },
      },
      {
        // BENCHMARKED LANE (2026-08-24, this machine, same-server A/B vs
        // google/gemma-4-12b): prism-ml/bonsai-27b, on disk as
        // .lmstudio/models/prism-ml/Ternary-Bonsai-27B-mlx-2bit — a ternary
        // (Qwen3.5-arch, 64-layer hybrid linear-attention) 27B, MLX engine,
        // 2-bit, served at FULL 262,144 context (native /api/v0/models:
        // loaded_context_length 262144, type vlm, capabilities [tool_use]).
        // VERDICT of the A/B: NOT a gemma upgrade — the lane is shared for
        // its 256K context + thinking-on 27B quality niche, while capability
        // specs stay on gemma-4-12b. Measured:
        //   • no-think honored: effort "none" → 0 reasoning tokens, clean
        //     JSON direct in content, 0.22s tiny ask (gemma 0.36s — both
        //     sub-0.4s, indistinguishable in practice)
        //   • prefill (same ~7.5K-token payload, same day): 8.4s / ~917
        //     tok/s vs gemma 4.1s / ~1,814 tok/s — gemma ~2× faster
        //   • prompt KV cache DOES serve repeats on this MLX lane (0.29s
        //     repeat) — unlike the llama.cpp QAT lane
        //   • no-think trap battery: 3/5 (bat/ball answered 10 = the
        //     reflexive error, strawberry counted 2; gemma 5/5) — with
        //     thinking ON bonsai corrects bat/ball (5, 339 reasoning tokens),
        //     so the misses are the no-think path's System-1 slips, not
        //     model ignorance. Also ignores "just the number" brevity asks
        //     more often than gemma.
        //   • vision verified with a valid solid-red 64×64 PNG → "Red", 0
        //     reasoning tokens, effort:none path (NOTE: malformed images
        //     400 with "Invalid image detected at index 0" — probe your
        //     payload, don't blame the lane)
        //   • effort levels low/medium/high/xhigh all 200-OK (server accepts
        //     the same wire enum as gemma; map mirrors it)
        // SECOND A/B (2026-08-24 19:3x, both lanes resident on the MLX engine,
        // effort none, temp 0, 3 runs/shape) — adds DECODE + warm-tiny numbers:
        //   • prefill 3.3K-token prompt, COLD first run: bonsai 3.49s (~962
        //     tok/s) vs gemma 2.07s (~1,593 tok/s) — gemma ~1.7× faster, same
        //     ratio as the 7.5K first A/B above; warm repeats ~0.2-0.3s BOTH
        //     lanes (prompt KV cache serves both MLX engines)
        //   • decode (300+ word answer): bonsai 53.7 tok/s vs gemma 64.1
        //     tok/s — gemma only ~19% faster on decode; prefill is where the
        //     ~2× gap lives
        //   • tiny ask warm: bonsai 155ms vs gemma 65ms — both sub-0.2s,
        //     indistinguishable for routing decisions
        id: "prism-ml/bonsai-27b",
        name: "Bonsai 27B Ternary (LM Studio)",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 262_144,
        maxTokens: 65_536,
        compat: { supportsReasoningEffort: true },
        thinkingLevelMap: {
          off: "none",
          minimal: "none",
          low: "low",
          medium: "medium",
          high: "high",
          max: "xhigh",
          xhigh: "xhigh",
        },
      },
    ],
  },

  // DeepSeek's public API, OpenAI style. This REGISTERS OVER the baked pi-ai
  // catalog provider "deepseek" (pi-ai@0.84.2 providers/data/deepseek.json
  // ships only deepseek-v4-flash / deepseek-v4-pro): the extension-provider
  // path REPLACES a provider's model list with the extension's (applyExtension
  // → config.models.map), so every baked model is re-listed below — omitting
  // one makes it vanish from `--list-models` and breaks the
  // "deepseek/deepseek-v4-flash*" refs (obsidianSubagentFloor = the vision-exp
  // sibling; model-tiers.json seeds use the base flash). Fields mirror the
  // baked entries; detectCompat()
  // would infer the same compat from provider id + baseUrl, but pinning it
  // keeps the behavior stable across pi-ai upgrades.
  //
  // Measured 2026-08-23 (OpenAI-style /v1/chat/completions):
  //   • deepseek-v4-flash-vision-exp → 200; the "...exp[1m]" alias → 400
  //     ("supported API model names are deepseek-v4-pro, deepseek-v4-flash,
  //     and deepseek-v4-flash-vision-exp") — [1m] exists only on the
  //     Anthropic-compatible gateway at /anthropic/v1/messages, which pi
  //     does not use for this endpoint. 1M context is the family default, so
  //     the suffix carries no info here.
  //   • thinking is ALWAYS ON: with max_tokens=8 the whole budget went to
  //     reasoning (reasoning_content) and content came back empty with
  //     finish_reason "length" — the same shared reason+answer budget that
  //     motivated the 65_536 maxTokens cap on the LM Studio entries.
  //     384_000 keeps the headroom the baked siblings use.
  //   • reasoning_effort="high" is accepted (see scripts/claude-code-deepseek.sh
  //     posture); the thinkingLevelMaps mirror the baked entries.
  "deepseek": {
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions",
    // pi config-template form: resolved from the env by pi's own config
    // machinery at request time, so the provider shows "not configured" when
    // DEEPSEEK_API_KEY is unset. ({ env: ... } here would freeze the literal
    // at registration and claim configured with an empty key.)
    apiKey: "$DEEPSEEK_API_KEY",
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
    },
    models: [
      // The two baked entries re-listed verbatim (minus cost — the
      // registration convention zeroes costs; see registerAllProviders).
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        reasoning: true,
        input: ["text"],
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
      },
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        reasoning: true,
        input: ["text"],
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
      },
      {
        id: "deepseek-v4-flash-vision-exp",
        name: "DeepSeek V4 Flash Vision EXP",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        // Mirrors the baked siblings' headroom: reasoning shares the
        // reason+answer budget (an 8-token probe returned EMPTY content with
        // finish_reason "length"), so a small cap truncates the reply.
        maxTokens: 384_000,
        thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
      },
    ],
  },

  // Z.AI's GLM coding API, OpenAI style. This REGISTERS OVER the baked pi-ai
  // catalog provider "zai" (pi-ai@0.84.2 providers/data/zai.json ships
  // glm-4.7 / glm-5-turbo / glm-5.2 / glm-5.2-highspeed / glm-5.3, all
  // text-only): the extension-provider path REPLACES a provider's model list
  // with the extension's, so every baked model is re-listed below verbatim
  // (minus cost — the registration convention zeroes costs) — omitting one
  // makes it vanish from `--list-models` and breaks the "zai/glm-*" refs in
  // DEFAULT_MODEL_TIER_CONFIG / the glm-lmstudio preset. Fields mirror the
  // baked entries; detectCompat() would infer most of this compat from
  // provider id + baseUrl — EXCEPT zaiToolStream, which detectCompat()
  // hardcodes to false (pi-ai dist/api/openai-completions.js detectCompat):
  // `zaiToolStream: true` here is the ONE pin the fold cannot re-derive.
  // Dropping it as "redundant" silently turns off tool-call streaming for
  // the repo's DEFAULT provider (openai-completions.js reads
  // `compat.zaiToolStream ?? detected`) — pinned by
  // pre-load-providers.test.ts's folded-compat assertion (2026-08-28).
  //
  // glm-5.3-flash (added 2026-08-27, user request — mirrors
  // scripts/claude-code-glm.sh's AIR-tier glm-5.3-flash[1m]): declared with
  // input text+image — the [1m] suffix exists only on the Anthropic gateway
  // (same measurement as deepseek's), so the id here is the bare one on the
  // coding endpoint, contextWindow 1M per the family's [1m] naming. Vision
  // verified with a real image call 2026-08-27 (see the ticket receipt).
  "zai": {
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    api: "openai-completions",
    // pi config-template form: resolved from the env by pi's own config
    // machinery at request time (same as deepseek above) — the key lives in
    // the user's shell env (~/.zshrc), NOT auth.json.
    apiKey: "$ZAI_API_KEY",
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "zai",
      zaiToolStream: true,
    },
    models: [
      {
        id: "glm-4.7",
        name: "GLM-4.7",
        reasoning: true,
        input: ["text"],
        contextWindow: 204_800,
        maxTokens: 131_072,
      },
      {
        id: "glm-5-turbo",
        name: "GLM-5-Turbo",
        reasoning: true,
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 131_072,
      },
      {
        id: "glm-5.2",
        name: "GLM-5.2",
        reasoning: true,
        input: ["text"],
        contextWindow: 1_000_000,
        maxTokens: 131_072,
        // The ONE baked zai entry with reasoning effort on — per-model compat
        // merges over the provider-level pin.
        compat: { supportsReasoningEffort: true },
        thinkingLevelMap: { minimal: null, low: "high", medium: "high", high: "high", max: "max" },
      },
      {
        id: "glm-5.2-highspeed",
        name: "GLM-5.2 Highspeed",
        reasoning: true,
        input: ["text"],
        contextWindow: 1_000_000,
        maxTokens: 131_072,
      },
      {
        id: "glm-5.3",
        name: "GLM-5.3",
        reasoning: true,
        input: ["text"],
        contextWindow: 1_000_000,
        maxTokens: 131_072,
      },
      {
        id: "glm-5.3-flash",
        name: "GLM-5.3 Flash",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        maxTokens: 131_072,
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
 * Pure: the per-provider `registerProvider(name, config)` configs for every
 * PROVIDERS entry (provider-level compat folded onto each model, apiKey
 * resolved, costs zeroed). Shared by registerAllProviders (the registry
 * mutation) AND the `__piBakedProviders` seam publishers
 * (patches/pre-load-providers.ts + cli/sessions/shared.ts), so the `cli`
 * namespace — which dispatches BEFORE applyPatches and therefore never sees
 * the ModelRuntime.create wrap — can still hand the catalog to low-level
 * runtimes that build their OWN registry (core-runtime's subagent registry,
 * otherwise models.json-only and blind to baked-only lanes like bonsai).
 */
export function bakedProviderConfigs(
  env: Record<string, string | undefined> = process.env,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(PROVIDERS)) {
    const { compat: providerCompat, ...rest } = entry;
    out[name] = {
      ...rest,
      apiKey: resolveApiKey(entry.apiKey, env),
      models: entry.models.map((m) => ({
        ...m,
        // The SDK's extension-provider path (applyExtension) honors only
        // model-level compat, so fold the provider-level compat down here.
        compat: { ...providerCompat, ...m.compat },
        cost: ZERO_COST,
      })),
    };
  }
  return out;
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
  for (const [name, config] of Object.entries(bakedProviderConfigs(env))) {
    registry.registerProvider(name, config);
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
	obsidianSubagentFloor: "deepseek/deepseek-v4-flash-vision-exp",
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
	// `capabilities.vision` = prism-ml/bonsai-27b with the no-think pin (user
	// directive 2026-08-24 — QUALITY over speed for the vision lane; gemma
	// stays the fallback catalog lane and remains ~5× faster per image call
	// measured 2026-08-24: cache-busted 1672×941 real image, bonsai 3.4–3.8s
	// with richer descriptions vs gemma 0.5–0.8s — flip the spec back if
	// captioning throughput ever matters more than description depth). The
	// `:off` suffix makes every vision call run thinking-off; the bonsai
	// catalog entry maps it to `reasoning_effort:"none"` (measured honored
	// 2026-08-24: 0 reasoning tokens, direct content). The same suffix on the
	// CLI `--model` path is dropped by a session-creation handoff bug (see
	// the study note above LM_STUDIO_COMPAT) — the capability-spec path was
	// not re-verified end-to-end; if vision calls start emitting reasoning
	// burn, suspect that handoff, not this spec.
	capabilities: {
		vision: "lm-studio/prism-ml/bonsai-27b:off",
		"vision-large": "lm-studio/prism-ml/bonsai-27b:off",
		"vision-medium": "lm-studio/prism-ml/bonsai-27b:off",
		"vision-small": "lm-studio/prism-ml/bonsai-27b:off",
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

// ─── §4 Embedding config (knowledge layer) ────────────────────────────────

/** Baked embedding endpoint + model for the knowledge layer (kcard-parity D8,
 *  ticket 01): ONE place for all baked model config. `base` is DERIVED from
 *  the lm-studio PROVIDERS entry (strip the /v1 suffix) — no second copy of
 *  the endpoint; `model` is authored HERE (canonical) so this file carries
 *  every LLM-related setting with NO imports (user directive 2026-08-24;
 *  core-interface cannot own it without an import cycle, since it sits BELOW
 *  this package). Published at startup by the pre-load-providers patch via
 *  publishSeam("__piEmbeddingConfig", …); embedding-leaf.ts
 *  resolveSemanticEmbedConfig resolution order = seam → env
 *  (SEMANTIC_EMBED_* / LMSTUDIO_BASE_URL) → its own host-absent fallback
 *  literal (kept identical by a drift-guard test here). Pure data —
 *  publishing happens in the side-effecting patch file, per this module's
 *  side-effect-free-by-design header. */
export interface EmbeddingConfig {
	base: string;
	model: string;
}

export const EMBEDDING_CONFIG: EmbeddingConfig = {
	base: PROVIDERS["lm-studio"]!.baseUrl.replace(/\/v1$/, ""),
	// Canonical embedding model id served by LM Studio (D3, effort
	// 2026-08-22-context-lifecycle): `text-embedding-bge-m3`. RE-CONFIRMED
	// 2026-08-23 by ticket 07's eval gate, which cut BOTH ways: the English
	// 50-query eval set favors nomic (48/50 vs 47/50 hit@4, receipt
	// output/d3-reeval/) — but the committed recall-audit battery (ticket 04,
	// the binding Done-when gate) regresses under nomic (15/20 vs 17/20 hit@5)
	// and the prior embed-bench measured bge-m3 recall@1 0.909 vs nomic 0.864.
	// D3 stays bge-m3; the 1-query English-set cost is recorded in the effort
	// map. nomic stays one env override (`SEMANTIC_EMBED_MODEL`) away. The
	// kcard semantic cache is model-keyed, so any swap is a cache-file change,
	// not a migration.
	model: "text-embedding-bge-m3",
};
