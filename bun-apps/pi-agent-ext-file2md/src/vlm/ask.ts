/**
 * ask.ts — generic single-turn "ask a question about ONE image" VLM subagent.
 *
 * Unlike classify-vlm.ts / agents.ts (Obsidian-page-extraction-specific), this
 * is a bare primitive: any pi-file2md consumer package can hand it an image path +
 * a free-form question and get the model's reply text back, without writing
 * its own LM Studio client or session plumbing. Defaults to the same shared
 * VLM target as the rest of pi-file2md (lm-studio/google/gemma-4-12b-qat).
 */
import { extname } from "node:path";
import { readFileSync } from "node:fs";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createSharedSession, resolveLLM, type ResolvedLLM } from "../sessions.ts";

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
 * @param opts.llm      explicit LLM target; defaults to resolveLLM({}) (lm-studio Gemma)
 * @param opts.agentDir  resolve models.json from THIS directory instead of the
 *                        global ~/.pi/agent (see createSharedSession's doc)
 * @param opts.modelRuntime  explicit, file-independent ModelRuntime (see
 *                        createSharedSession's doc) — takes precedence over agentDir
 */
export async function askImage(
  imagePath: string,
  question: string,
  opts: { mimeType?: string; systemPrompt?: string; llm?: ResolvedLLM; agentDir?: string; modelRuntime?: ModelRuntime } = {},
): Promise<AskImageResult> {
  const llm = opts.llm ?? resolveLLM({});
  const mimeType = opts.mimeType ?? guessImageMimeType(imagePath);
  const { session } = await createSharedSession(llm, {
    appendSystemPrompt: opts.systemPrompt ? [opts.systemPrompt] : undefined,
    agentDir: opts.agentDir,
    modelRuntime: opts.modelRuntime,
  });

  const image = readImage(imagePath, mimeType);
  let reply = "";
  const unsub = session.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      reply += event.assistantMessageEvent.delta;
    }
  });

  try {
    await session.prompt(question, { images: [image] } as any);
    return { reply: reply.trim(), ok: true };
  } catch (e: any) {
    return { reply: "", ok: false, error: e?.message ?? String(e) };
  } finally {
    unsub();
    session.dispose();
  }
}
