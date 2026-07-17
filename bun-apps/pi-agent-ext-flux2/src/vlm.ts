/**
 * vlm.ts — thin adapter over pi-file2md's shared VLM subagent, used only by the
 * scene-pipeline's `verifyPrompt` step (scenePipeline.ts).
 *
 * This is deliberately NOT a new LM Studio client: `askImage`/`resolveLLM`
 * already live in pi-file2md (bun-apps/pi-agent-ext-file2md/src/vlm/ask.ts + sessions.ts) and
 * are exported specifically for reuse by other tools (see its README). This
 * module just adapts pi-file2md's shapes to scenePipeline.ts's injectable
 * `AskAboutImage` signature.
 *
 * Model resolution is FILE-INDEPENDENT: the lm-studio provider config is
 * built directly in code (lmStudioRegistry() below) and passed as an
 * explicit ModelRegistry, rather than depending on a models.json file at
 * some path. Both this repo's project-local `.pi/agent/models.json` AND the
 * user's global `~/.pi/agent/models.json` have been observed missing/deleted
 * by unrelated changes elsewhere in this repo's history — depending on
 * either one is fragile across sessions/branches. See memory
 * [[pi-vlm-agentdir-global-vs-project]].
 *
 * Imported lazily (dynamic `import()`) from index.ts so the base flux2 tool
 * (t2i/scene/upscale/... without a pipeline) never pays for pi-file2md's session
 * machinery.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { askImage, resolveLLM, type ResolvedLLM } from "@repo/pi-agent-ext-file2md";

// Cache the async-init *promise* so the runtime is built exactly once and
// every caller awaits the same in-flight build. (ModelRuntime.create is async
// in 0.80.10 — auth/model orchestration was folded into ModelRuntime and the
// old sync ModelRegistry.create/inMemory + AuthStorage factories were removed
// from the public exports.)
let _lmStudioRuntimePromise: Promise<ModelRuntime> | null = null;

/** Zero cost — LM Studio is a free local server, not a metered API. */
const FREE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const LM_STUDIO_COMPAT = { supportsDeveloperRole: false, supportsReasoningEffort: false } as const;

/**
 * Build (and cache) a ModelRuntime that registers the lm-studio provider
 * directly — no models.json file read, ever. Mirrors the config this repo
 * previously shipped at `.pi/agent/models.json` (deleted upstream by an
 * unrelated commit — see the module doc above).
 *
 * 0.80.10 migration: ModelRuntime.create() owns auth (LM Studio's apiKey is
 * baked into the registered provider config, so no credential store is
 * needed). ModelRuntime is the new interchange type pi-file2md's askImage
 * consumes.
 */
function lmStudioRuntime(): Promise<ModelRuntime> {
  if (_lmStudioRuntimePromise) return _lmStudioRuntimePromise;
  _lmStudioRuntimePromise = (async () => {
    const runtime = await ModelRuntime.create();
    runtime.registerProvider("lm-studio", {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      apiKey: "lm-studio",
      models: [
        { id: "google/gemma-4-26b-a4b-qat", name: "Gemma 4 26B (LM Studio)", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 16384, cost: FREE_COST, compat: LM_STUDIO_COMPAT },
        { id: "google/gemma-4-31b-qat", name: "Gemma 4 31B (LM Studio)", reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 16384, cost: FREE_COST, compat: LM_STUDIO_COMPAT },
        { id: "qwen/qwen3-vl-4b", name: "Qwen3 VL 4B (LM Studio)", reasoning: true, input: ["text", "image"], contextWindow: 131072, maxTokens: 16384, cost: FREE_COST, compat: LM_STUDIO_COMPAT },
      ],
    });
    return runtime;
  })();
  return _lmStudioRuntimePromise;
}

/** Default: lm-studio/google/gemma-4-26b-a4b-qat (per pi-file2md's resolveLLM default). */
export function resolveVlmLLM(modelOverride?: string): ResolvedLLM {
  return resolveLLM(modelOverride ? { model: modelOverride } : {});
}

export async function askAboutImage(
  imagePath: string,
  question: string,
  llm: ResolvedLLM,
): Promise<{ reply: string; ok: boolean }> {
  try {
    // Defensive: pi-file2md's askImage only wraps session.prompt() in try/catch —
    // readFileSync(imagePath) and createSharedSession() run outside that try
    // block, so a not-yet-flushed image or an LM Studio connection failure
    // throws instead of resolving {ok:false} as this function's own return
    // type promises its callers. Never let that escape as an uncaught throw.
    const result = await askImage(imagePath, question, { llm, modelRuntime: await lmStudioRuntime() });
    return { reply: result.reply, ok: result.ok };
  } catch {
    return { reply: "", ok: false };
  }
}
