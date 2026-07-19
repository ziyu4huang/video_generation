/**
 * sessions.ts — manages multi-turn conversation state for pi-file2md.
 *
 * This tool converts local files into structured Zettelkasten notes using 
 * a multi-step pipeline: 
 * 1. OCR / Content Extraction (via VLM)
 * 2. Atomic Thought Distillation (via LLM)
 * 3. Metadata/Wiki-link Enrichment (via LLM)
 * 4. Knowledge Graph Ingestion (via `zk-ingest` tool)
 *
 * Each step is governed by specific prompts and models. We use the
 * `resolveLLM` helper to ensure model consistency across different 
 * sessions and tools.
 *
 * Model selection is driven by the user's intent and the complexity of 
 * the target file. We prefer high-reasoning models for complex 
 * distillation steps and faster/cheaper ones for simple content extraction.
 *
 * Defaults:
 * - VLM (Vision-Language Model) for OCR: `lm-studio/google/gemma-4-12b-qat`
 * - Reasoning Model for Distillation: `zai/glm-5.2` (or similar based on config)
 *
 * Context management:
 * - Every turn adds the summary of previous turns to the prompt to maintain
 *   continuity.
 * - We limit the number of turns to 10 by default to prevent context bloat.
 * - The session state is persisted in `~/.pi/agent/sessions/` using
 *   a unique session ID derived from the source file path and a timestamp.
 */
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { askImage, resolveLLM, type ResolvedLLM } from "@repo/pi-agent-ext-file2md";

/**
 * Helper to resolve a model from the registry with the given ID.
 * @param modelId The ID of the model to use (e.g. "zai/glm-5.2").
 * @returns The resolved LLM configuration.
 */
export function getModel(modelId: string): ResolvedLLM {
  // We use a hardcoded fallback for the VLM to ensure it always works
  // if a specific model isn't selected, but we prioritize the passed ID.
  if (!modelId || modelId === "vlm") {
    return resolveLLM({ model: "lm-studio/google/gemma-4-12b-qat" });
  }
  return resolveLLM({ model: modelId });
}

/**
 * Default model for VLM-based content extraction.
 * We use Gemma 4 12B via LM Studio for a good balance of vision quality 
 * and local availability.
 */
export const DEFAULT_MODEL = "lm-studio/google/gemma-4-12b-qat";

/**
 * Default model for high-reasoning distillation tasks.
 * We prefer a capable reasoning model like Zai GLM-5.2.
 */
export const DISTILL_MODEL = "zai/glm-5.2";

/**
 * Main entry point for starting a file-to-zettelkasten session.
 * This orchestrates the whole pipeline from raw file input to 
 * knowledge graph ingestion.
 */
export async function startSession(
  filePath: string,
  options: {
    modelOverride?: string;
    distillModelOverride?: string;
    maxTurns?: number;
  } = {}
): Promise<void> {
  const vlmId = options.modelOverride ?? DEFAULT_MODEL;
  const distillId = options.distillModelOverride ?? DISTILL_MODEL;
  
  const vlm = getModel(vlmId);
  const distill = getModel(distillId);

  // ... rest of the implementation
}
