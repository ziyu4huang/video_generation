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
import { roleAwareDirectCall, spawnSubagent } from "@repo/s2-agent-core-runtime";
import type { ResolvedLLM } from "../sessions.js";

export interface VisionInferenceResult {
  /** The assistant's raw text (trimmed). */
  output: string;
  ok: boolean;
  error?: string;
  /**
   * True when the child COMPLETED (no failure) but produced no output text.
   * On an always-on-reasoning VLM (e.g. LM Studio's Qwen3.8 MLX) the reasoning
   * burn can consume the whole output budget and yield an empty `content` with
   * no failure — a silent empty page. Callers that treat empty as unusable can
   * set `emptyIsError` to surface it as `ok:false` instead of `ok:true + ""`.
   */
  empty?: boolean;
}

/**
 * A vision model returning no text at all after completing. Distinguishes the
 * always-on-reasoning truncation footgun (reasoning burned the whole budget →
 * empty content, no failure) from a genuine retriable error. Kept out of the
 * throw path so callers (and the ask-io suite's "empty output is still ok:true"
 * contract for a *legitimately* empty reply) can opt in explicitly.
 */
export const MIN_VISION_OUTPUT_CHARS = 1;

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
  /**
   * Treat a completed-and-empty output as `ok:false` instead of `ok:true + ""`.
   * Default false (a vision model may legitimately answer with no text). Set
   * true for surfaces where an empty reply is unusable — e.g. a page whose
   * body would then silently be blank due to the reasoning-burn truncation.
   */
  emptyIsError?: boolean;
  /**
   * Cancel lever, threaded to spawnSubagent's externalSignal (#1948): a caller
   * (test harness, pipeline) that gives up — e.g. its test just timed out —
   * aborts the in-flight child immediately instead of leaving it running under
   * its own 5-min recon fuse, holding sockets (and the test process) open.
   */
  signal?: AbortSignal;
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
    // 2026-08-18 final repo-wide closure (#1658/#1660 companions): last raw
    // spawnSubagent consumer — recon caps + abort-safety footer travel together;
    // SUBAGENT_TOKEN_BUDGET_DISABLE strips both. Vision inference is a
    // read-and-describe call → recon archetype (envelope wall, not writer caps).
    const venv = roleAwareDirectCall("recon", opts.task, `file2md-vision-${Date.now()}`);
    const result = await spawnSubagent({
      task: venv.task,
      images: opts.images,
      ...(opts.signal ? { externalSignal: opts.signal } : {}),
      ...(venv.tokenBudget !== undefined
        ? { tokenBudget: venv.tokenBudget, maxTurns: venv.maxTurns, timeoutMs: venv.timeoutMs }
        : {}),
      ...(opts.systemPrompt ? { instructions: opts.systemPrompt } : {}),
      ...(modelSpec ? { model: modelSpec } : {}),
      ...(capability ? { capability } : {}),
      ...(Object.keys(sessionOverride).length ? { session: sessionOverride } : {}),
    });
    const trimmed = (result.output ?? "").trim();
    const empty = !result.failure && trimmed.length < MIN_VISION_OUTPUT_CHARS;
    if (empty && opts.emptyIsError) {
      // Completed but no text — the classic silent-empty page. The VM completed
      // (no failure) yet returned nothing: on an always-on-reasoning VLM this is
      // the reasoning-burn-truncated-output case most of the time. Surface it
      // explicitly so the caller degrades (OCR fallback / clear message) rather
      // than quietly writing a blank page as if it were valid.
      return {
        output: "",
        ok: false,
        empty: true,
        error: "vision model completed with no output text (possible reasoning/token-budget truncation)",
      };
    }
    return {
      output: trimmed,
      ok: !result.failure,
      ...(empty ? { empty: true } : {}),
      ...(result.failure ? { error: result.failure.message } : {}),
    };
  } catch (e: any) {
    return { output: "", ok: false, error: e?.message ?? String(e) };
  }
}
