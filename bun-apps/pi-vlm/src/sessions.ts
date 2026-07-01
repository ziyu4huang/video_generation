/**
 * Simplified session factory for VLM calls.
 *
 * Provides the same surface as bun-pi-agent-cli/src/sessions/shared.ts but:
 *  - No pi-obsidian extension baked in (VLM calls are pure inference, no vault tools needed)
 *  - No custom buildModelRegistry() — uses the standard ~/.pi/ registry which already has
 *    lm-studio configured per the project CLAUDE.md
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type { ThinkingLevel };

// createSharedSession + resolveModel live in ./session-factory.ts so tests can
// mock the factory without clobbering resolveLLM below. Re-exported here for
// import-path stability (callers import createSharedSession from "./sessions").
export { createSharedSession } from "./session-factory.js";

const THINKING_LEVELS: readonly string[] = [
  "off", "minimal", "low", "medium", "high", "xhigh",
];

export interface ResolvedLLM {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

/**
 * Resolve LLM target from options. Accepts "provider/modelId" shorthand in model.
 * Defaults to lm-studio/google/gemma-4-26b-a4b-qat for VLM work.
 */
export function resolveLLM(opts: {
  provider?: string;
  model?: string;
  thinking?: string;
}): ResolvedLLM {
  const DEFAULT_MODEL = "lm-studio/google/gemma-4-26b-a4b-qat";

  let model = opts.model ?? process.env.PI_MODEL ?? DEFAULT_MODEL;
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


