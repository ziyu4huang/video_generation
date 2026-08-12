/**
 * ask.ts — generic single-turn "ask a question about ONE image" VLM subagent.
 *
 * Unlike classify-vlm.ts / agents.ts (Obsidian-page-extraction-specific), this
 * is a bare primitive: any pi-file2md consumer package can hand it an image path +
 * a free-form question and get the model's reply text back, without writing
 * its own LM Studio client or session plumbing. Defaults to the same shared
 * VLM target as the rest of pi-file2md (lm-studio/google/gemma-4-12b-qat).
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type ResolvedLLM, resolveVisionLLM } from "../sessions.ts";
import { runVisionInference } from "./vision-inference.js";

export interface AskImageResult {
  reply: string;
  ok: boolean;
  error?: string;
}

/** Best-effort mime type from a file extension (flux2/most tools only ever emit PNG). */
export function guessImageMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".bmp":
      return "image/bmp";
    default:
      return "image/png";
  }
}

function readImage(abs: string, mimeType: string) {
  const data = Buffer.from(readFileSync(abs)).toString("base64");
  return { type: "image" as const, data, mimeType };
}

/**
 * Ask a VLM one question about one image via a fresh, disposable pi-agent
 * subagent session (one turn). Returns the raw reply text (trimmed).
 *
 * @param imagePath     absolute path to the image
 * @param question      free-form question / instruction for the model
 * @param opts.systemPrompt  optional system prompt (e.g. "answer in one line")
 * @param opts.llm      explicit LLM target; defaults to resolveVisionLLM() (capabilities.vision or lm-studio Gemma)
 * @param opts.agentDir  resolve models.json from THIS directory instead of the
 *                        global ~/.pi/agent (forwarded to runVisionInference)
 * @param opts.modelRuntime  explicit, file-independent ModelRuntime (forwarded
 *                        to runVisionInference) — takes precedence over agentDir
 */
export async function askImage(
  imagePath: string,
  question: string,
  opts: {
    mimeType?: string;
    systemPrompt?: string;
    llm?: ResolvedLLM;
    agentDir?: string;
    modelRuntime?: ModelRuntime;
  } = {},
): Promise<AskImageResult> {
  const llm = opts.llm ?? resolveVisionLLM();
  const mimeType = opts.mimeType ?? guessImageMimeType(imagePath);
  const image = readImage(imagePath, mimeType);

  const { output, ok, error } = await runVisionInference({
    task: question,
    images: [image],
    llm,
    ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
    ...(opts.agentDir ? { agentDir: opts.agentDir } : {}),
    ...(opts.modelRuntime ? { modelRuntime: opts.modelRuntime } : {}),
  });

  return ok ? { reply: output, ok: true } : { reply: "", ok: false, error };
}
