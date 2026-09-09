/**
 * vision-llm-leaf.ts — the ONE vision-LLM contract shared across extensions
 * (self-arc-20 ticket 01). The IMPLEMENTATION lives in s2-agent-ext-file2md
 * (vlm/ask.ts `askImage` + sessions.ts `resolveVisionLLM`) and is published on
 * the `__piVisionLLM` seam at extension load; consumers (flux2 scene-pipeline
 * VLM verify, and any future consumer) read the seam instead of importing the
 * file2md package — the __piHermesStaleCheck precedent for a published reader
 * that must not create an ext→ext import edge.
 *
 * Pure contract — no imports at all. `ResolvedLLM` widens `thinkingLevel` to
 * `string` (file2md's concrete type pins it to pi-agent-core's ThinkingLevel
 * union; concrete is assignable here, and every runtime value still
 * originates from file2md's resolver, which only emits valid union members —
 * the publisher boundary cast in extensions/file2md.ts documents this).
 */

/** The resolved vision-LLM target (structural; see module doc on thinkingLevel). */
export interface ResolvedLLM {
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

/** Options for a single-turn image ask (mirrors file2md askImage's opts —
 *  `modelRuntime` is typed unknown here so this leaf stays pi-free; the
 *  publisher boundary cast documents that only pi-coding-agent ModelRuntime
 *  values are passed in practice). */
export interface VisionImageAskOptions {
  mimeType?: string;
  systemPrompt?: string;
  llm?: ResolvedLLM;
  agentDir?: string;
  modelRuntime?: unknown;
  /** Treat a completed but empty reply as ok:false (file2md runVisionInference). */
  emptyIsError?: boolean;
  signal?: AbortSignal;
}

export interface VisionImageAskResult {
  reply: string;
  ok: boolean;
  error?: string;
  /** True when the model completed but produced no text (reasoning truncation). */
  empty?: boolean;
}

/** The `__piVisionLLM` seam shape: file2md publishes BOTH the vision-model
 *  resolver and the image asker so a consumer never needs either function
 *  directly. */
export interface VisionLLMSeam {
  resolveVisionLLM(
    opts?: { model?: string; provider?: string; thinking?: string; tier?: "large" | "medium" | "small" },
  ): ResolvedLLM;
  askImage(imagePath: string, question: string, opts?: VisionImageAskOptions): Promise<VisionImageAskResult>;
}
