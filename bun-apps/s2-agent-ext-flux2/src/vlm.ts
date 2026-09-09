/**
 * vlm.ts — thin adapter over the shared VLM primitive, used only by the
 * scene-pipeline's `verifyPrompt` step (scenePipeline.ts).
 *
 * This is deliberately NOT a new LM Studio client: the shared
 * `askImage`/`resolveVisionLLM` implementation lives in pi-file2md
 * (bun-apps/s2-agent-ext-file2md/src/vlm/ask.ts + sessions.ts) and reaches this
 * package through the `__piVisionLLM` seam (contract: `VisionLLMSeam` in
 * s2-agent-core-interface/src/vision-llm-leaf.ts) — file2md publishes it at
 * extension load, this module reads it (self-arc-20 ticket 01: no ext→ext
 * import). This module just adapts the seam's shapes to scenePipeline.ts's
 * injectable `AskAboutImage` signature.
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
 * (t2i/scene/upscale/... without a pipeline) never pays for the seam-read
 * module graph.
 */
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { readSeam, type ResolvedLLM, type VisionLLMSeam } from "@repo/s2-agent-core-interface";

/**
 * The published vision-LLM seam. Throws (never returns undefined) when
 * file2md is not loaded — including when it self-disabled via
 * BUN_PI_FILE2MD=0, which skips the publish. The message names the fix.
 */
function visionSeam(): VisionLLMSeam {
  const seam = readSeam("__piVisionLLM");
  if (!seam) {
    throw new Error(
      "[flux2] vision seam __piVisionLLM is not published — the s2-agent-ext-file2md extension is not loaded " +
        "(or disabled via BUN_PI_FILE2MD=0). Enable file2md, or inject scenePipeline's askAboutImage directly.",
    );
  }
  return seam;
}

let _lmStudioRegistry: Promise<ModelRegistry> | null = null;

/** Zero cost — LM Studio is a free local server, not a metered API. */
const FREE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const LM_STUDIO_COMPAT = { supportsDeveloperRole: false, supportsReasoningEffort: false } as const;

/**
 * Build (and cache) an in-memory ModelRegistry that registers the lm-studio
 * provider directly — no models.json file read, ever. Mirrors the config
 * this repo previously shipped at `.pi/agent/models.json` (deleted upstream
 * by an unrelated commit — see the module doc above).
 */
async function lmStudioRegistry(): Promise<ModelRegistry> {
  if (_lmStudioRegistry) return _lmStudioRegistry;
  _lmStudioRegistry = ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null }).then(
    (runtime) => {
      const reg = new ModelRegistry(runtime);
      reg.registerProvider("lm-studio", {
        baseUrl: "http://localhost:1234/v1",
        api: "openai-completions",
        apiKey: "lm-studio",
        models: [
          { id: "prism-ml/bonsai-27b", name: "Bonsai 27B (LM Studio)", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 16384, cost: FREE_COST, compat: LM_STUDIO_COMPAT },
        ],
      });
      return reg;
    },
  );
  return _lmStudioRegistry;
}

/** Central vision slot: capabilities.vision from ~/.pi/workflows/model-tiers.json
 *  (via the __piVisionLLM seam's resolver — explicit override > tier config >
 *  deprecated PI_MODEL env > actionable throw). */
export function resolveVlmLLM(modelOverride?: string): ResolvedLLM {
  return visionSeam().resolveVisionLLM(modelOverride ? { model: modelOverride } : {});
}

export async function askAboutImage(
  imagePath: string,
  question: string,
  llm: ResolvedLLM,
): Promise<{ reply: string; ok: boolean }> {
  try {
    // Defensive: file2md's askImage only wraps session.prompt() in try/catch —
    // readFileSync(imagePath) and createSharedSession() run outside that try
    // block, so a not-yet-flushed image or an LM Studio connection failure
    // throws instead of resolving {ok:false} as this function's own return
    // type promises its callers. Never let that escape as an uncaught throw.
    await lmStudioRegistry(); // ensure LM Studio registry initialized
    const result = await visionSeam().askImage(imagePath, question, { llm });
    return { reply: result.reply, ok: result.ok };
  } catch {
    return { reply: "", ok: false };
  }
}
