/**
 * vlm.ts — thin adapter over pi-vlm's shared VLM subagent, used only by the
 * scene-pipeline's `verifyPrompt` step (scenePipeline.ts).
 *
 * This is deliberately NOT a new LM Studio client: `askImage`/`resolveLLM`
 * already live in pi-vlm (bun-apps/pi-vlm/src/vlm/ask.ts + sessions.ts) and
 * are exported specifically for reuse by other tools (see its README). This
 * module just adapts pi-vlm's shapes to scenePipeline.ts's injectable
 * `AskAboutImage` signature.
 *
 * Imported lazily (dynamic `import()`) from index.ts so the base flux2 tool
 * (t2i/scene/upscale/... without a pipeline) never pays for pi-vlm's session
 * machinery or requires its agent-dir/model-registry to resolve.
 */
import { askImage, resolveLLM, type ResolvedLLM } from "pi-vlm";

/** Default: lm-studio/google/gemma-4-26b-a4b-qat (per pi-vlm's resolveLLM default). */
export function resolveVlmLLM(modelOverride?: string): ResolvedLLM {
  return resolveLLM(modelOverride ? { model: modelOverride } : {});
}

/**
 * `agentDir` MUST be this repo's own `<repoRoot>/.pi/agent` (not the global
 * ~/.pi/agent) — that project-local dir's checked-in `models.json` is the one
 * that actually declares the `lm-studio` provider this pipeline defaults to.
 * The global one is machine state outside this repo's control and may not
 * have it configured at all (see memory [[pi-vlm-agentdir-global-vs-project]]).
 */
export async function askAboutImage(
  imagePath: string,
  question: string,
  llm: ResolvedLLM,
  agentDir: string,
): Promise<{ reply: string; ok: boolean }> {
  try {
    // Defensive: pi-vlm's askImage only wraps session.prompt() in try/catch —
    // readFileSync(imagePath) and createSharedSession() run outside that try
    // block, so a not-yet-flushed image or an LM Studio connection failure
    // throws instead of resolving {ok:false} as this function's own return
    // type promises its callers. Never let that escape as an uncaught throw.
    const result = await askImage(imagePath, question, { llm, agentDir });
    return { reply: result.reply, ok: result.ok };
  } catch {
    return { reply: "", ok: false };
  }
}
