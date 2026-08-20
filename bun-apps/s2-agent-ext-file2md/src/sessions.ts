/**
 * Simplified session factory for VLM calls.
 *
 * Provides the same surface as bun-apps/s2-agent/src/cli/sessions/shared.ts but:
 *  - No pi-obsidian extension baked in (VLM calls are pure inference, no vault tools needed)
 *  - No custom buildModelRegistry() — uses the standard ~/.pi/ registry which already has
 *    lm-studio configured per the project CLAUDE.md
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { loadModelTierConfig, logModelDecision, resolveModelRole } from "@repo/s2-agent-ext-subagent";

// createSharedSession + resolveModel live in ./session-factory.ts so tests can
// mock the factory without clobbering resolveLLM below. Re-exported here for
// import-path stability (callers import createSharedSession from "./sessions").
export { createSharedSession } from "./session-factory.js";
export type { ThinkingLevel };

const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ResolvedLLM {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

/**
 * Resolve LLM target from options. Accepts "provider/modelId" shorthand in model.
 * Throws when no model is supplied (no opt, no PI_MODEL env, no config) — the
 * caller is expected to provide one via config (capabilities.vision) or env.
 */
export function resolveLLM(opts: { provider?: string; model?: string; thinking?: string }): ResolvedLLM {
  const fromEnv = process.env.PI_MODEL;
  let model = opts.model ?? fromEnv;
  if (!model) {
    throw new Error(
      "[file2md] No model configured. Set model config via `/models-preset` (or `/workflows-models`), or export PI_MODEL as a temporary escape hatch.",
    );
  }
  if (fromEnv && !opts.model) {
    console.error("[file2md] Using PI_MODEL env (deprecated) — set capabilities.vision via /models-preset.");
  }
  let provider = opts.provider ?? process.env.PI_PROVIDER ?? "lm-studio";
  let thinkingLevel: ThinkingLevel = (process.env.PI_THINKING ?? "off") as ThinkingLevel;

  // Parse "provider/modelId[:thinking]" shorthand
  const colon = model.lastIndexOf(":");
  const firstSlash = model.indexOf("/");
  if (colon > firstSlash && colon !== -1) {
    const maybeTh = model.slice(colon + 1);
    if (THINKING_LEVELS.includes(maybeTh)) {
      thinkingLevel = maybeTh as ThinkingLevel;
      model = model.slice(0, colon);
    }
  }
  if (model.includes("/")) {
    const slash = model.indexOf("/");
    provider = model.slice(0, slash);
    model = model.slice(slash + 1);
  }
  if (opts.thinking && THINKING_LEVELS.includes(opts.thinking)) {
    thinkingLevel = opts.thinking as ThinkingLevel;
  }

  return { provider, modelId: model, thinkingLevel };
}

/**
 * Resolve the vision LLM from the unified model-tiers config (capabilities.vision),
 * falling back to PI_MODEL/PI_PROVIDER env (deprecated) when the capability is not
 * configured. Explicit opts (model/provider/thinking) always win. Uses resolveLLM
 * as the spec-string parser, so "provider/modelId[:thinking]" shorthand still works.
 * Throws (via resolveLLM) when neither config nor env is set (ticket 01 contract).
 */
export function resolveVisionLLM(opts: { model?: string; provider?: string; thinking?: string } = {}): ResolvedLLM {
  if (opts.model) {
    logModelDecision("file2md-vision", { branch: "explicit-model", spec: opts.model });
    return resolveLLM(opts);
  }
  const spec = resolveModelRole({ capability: "vision" }, loadModelTierConfig());
  if (spec) {
    logModelDecision("file2md-vision", { branch: "capabilities.vision", spec });
    return resolveLLM({ ...opts, model: spec });
  }
  // No capabilities.vision configured — resolveLLM falls through to the PI_MODEL
  // env escape hatch (deprecated, warns) or throws an actionable error (ticket 01).
  logModelDecision("file2md-vision", { branch: "env/throw", spec: process.env.PI_MODEL });
  return resolveLLM(opts);
}
