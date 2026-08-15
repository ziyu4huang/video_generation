/**
 * vision-inference.ts — single seam routing file2md's VLM (vision) calls through
 * the shared spawnSubagent runner.
 *
 * Replaces the former createSharedSession + session.subscribe + session.prompt +
 * session.dispose boilerplate that was duplicated across classify-vlm.ts,
 * ask.ts, and agents.ts. Each caller now hands runVisionInference a task +
 * images (+ optional model/system/session opts) and gets back the assistant
 * text. Routing through spawnSubagent makes vision runs observable in the
 * /subagents viewer + uses the unified model config (capabilities.vision).
 *
 * Model resolution:
 *  - `llm` given, no custom runtime → its spec string; WorkflowAgent resolves
 *    via the HOST runtime (~/.pi/agent/models.json), exactly as the host would.
 *  - `modelRuntime` given → the host runtime can't see that model, so we
 *    pre-resolve it via ModelRegistry + inject as session.model (NO spec), so
 *    WorkflowAgent uses the session-injected model verbatim.
 *  - neither → capability "vision" (unified capabilities.vision config).
 */
import { ModelRegistry, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { spawnSubagent } from "@repo/pi-agent-ext-subagent";
import type { ResolvedLLM } from "../sessions.js";

export interface VisionInferenceResult {
  /** The assistant's raw text (trimmed). */
  output: string;
  ok: boolean;
  error?: string;
}

/** Convert a parsed ResolvedLLM into a "provider/modelId[:thinking]" spec string. */
function llmToSpec(llm: ResolvedLLM): string {
  const thinking = llm.thinkingLevel && llm.thinkingLevel !== "off" ? `:${llm.thinkingLevel}` : "";
  return `${llm.provider}/${llm.modelId}${thinking}`;
}

/**
 * Run a single-turn vision inference via spawnSubagent.
 *
 * @param opts.task        the user message / prompt for the model
 * @param opts.images      image content blocks ({type:"image",data,mimeType})
 * @param opts.llm         explicit model (spec); defaults to capability "vision"
 * @param opts.systemPrompt  → spawnSubagent instructions (the agent's system role)
 * @param opts.agentDir    resolve models.json from this dir (host-runtime path)
 * @param opts.modelRuntime  custom ModelRuntime (pre-resolves the model into session.model)
 */
export async function runVisionInference(opts: {
  task: string;
  images: unknown[];
  llm?: ResolvedLLM;
  systemPrompt?: string;
  agentDir?: string;
  modelRuntime?: ModelRuntime;
}): Promise<VisionInferenceResult> {
  let modelSpec: string | undefined;
  let capability: string | undefined;
  const sessionOverride: Record<string, unknown> = {};
  if (opts.agentDir) sessionOverride.agentDir = opts.agentDir;

  if (opts.modelRuntime) {
    // Custom runtime: pre-resolve so WorkflowAgent uses it verbatim (no spec).
    sessionOverride.modelRuntime = opts.modelRuntime;
    if (opts.llm) {
      const reg = new ModelRegistry(opts.modelRuntime);
      const found = reg.find(opts.llm.provider, opts.llm.modelId);
      if (!found) {
        return {
          output: "",
          ok: false,
          error: `Model "${opts.llm.provider}/${opts.llm.modelId}" not found in the provided modelRuntime`,
        };
      }
      sessionOverride.model = found;
    }
  } else if (opts.llm) {
    // Host runtime: resolve via spec string.
    modelSpec = llmToSpec(opts.llm);
  } else {
    // No explicit model → unified capabilities.vision config.
    capability = "vision";
  }

  try {
    const result = await spawnSubagent({
      task: opts.task,
      images: opts.images,
      ...(opts.systemPrompt ? { instructions: opts.systemPrompt } : {}),
      ...(modelSpec ? { model: modelSpec } : {}),
      ...(capability ? { capability } : {}),
      ...(Object.keys(sessionOverride).length ? { session: sessionOverride } : {}),
    });
    return {
      output: (result.output ?? "").trim(),
      ok: !result.failure,
      ...(result.failure ? { error: result.failure.message } : {}),
    };
  } catch (e: any) {
    return { output: "", ok: false, error: e?.message ?? String(e) };
  }
}
