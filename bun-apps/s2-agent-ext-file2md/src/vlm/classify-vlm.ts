/**
 * Semantic document classifier — a tiny VLM subagent that looks at the
 * rasterized first page and decides which content `DocProfile` applies, so the
 * orchestrator can pick the matching per-page system prompt.
 *
 * This is intentionally a separate, single-turn model call (not the main
 * extraction agent): classification should be fast, cheap, and return exactly
 * one of the known profile tokens.
 */
import { readFileSync } from "node:fs";
import { type ResolvedLLM, resolveVisionLLM } from "../sessions.ts";
import { ALL_PROFILES, type DocProfile } from "./classify.ts";
import { runVisionInference } from "./vision-inference.js";

const _CLASSIFY_SYSTEM = `你是一個文件類型分類器。你會收到一張文件的第一頁圖片。
請只判斷這份文件屬於下列哪一種 profile，並「只」輸出該 profile 的英文代碼（小寫），不要任何其他文字：

- paper   ：學術論文 / 研究報告（含標題、作者、摘要、章節、參考文獻的典型論文版面）
- slides  ：簡報投影片（橫向、單張大標題+條列、頁碼像 1/N）
- poster  ：學術/會議海報（單一大版面、多欄、含圖表）
- diagram ：圖表 / 流程圖 / 架構圖 / 數學推導草圖（以圖形為主、少量文字）
- image   ：一般照片 / 截圖 / 其他無法歸類者

判斷準則以「視覺版面」為主。輸出格式：僅一行，內容是上述五個代碼之一。`;

/** Parse the model's reply into a profile, tolerating surrounding noise. */
export function parseProfileReply(reply: string): DocProfile {
  const lower = reply.toLowerCase();
  // longest-match first so "image" doesn't shadow nothing
  for (const p of ALL_PROFILES) {
    if (lower.includes(p)) return p;
  }
  return "image"; // safe fallback
}

/** Read an image into a base64 ImageContent block. */
function readImage(abs: string, mimeType: string) {
  const data = Buffer.from(readFileSync(abs)).toString("base64");
  return { type: "image" as const, data, mimeType };
}

/**
 * Run the VLM classifier on a single representative image (usually page 1).
 *
 * @param imagePath  absolute path to the page-1 PNG
 * @param mimeType   image mime type
 * @param llmOverride  optional explicit LLM target (defaults to the same model
 *                     used for extraction; typically LM Studio Gemma)
 * @returns the detected profile + the raw reply text
 */
export async function classifyProfileViaVlm(
  imagePath: string,
  mimeType: string,
  llmOverride?: ResolvedLLM,
  signal?: AbortSignal,
): Promise<{ profile: DocProfile; reply: string }> {
  const llm = llmOverride ?? resolveVisionLLM();
  const image = readImage(imagePath, mimeType);

  const { output, ok, error } = await runVisionInference({
    task: "請分類這份文件的第一頁，只輸出一個 profile 代碼。",
    images: [image],
    llm,
    ...(signal ? { signal } : {}),
  });

  // The classifier does NOT swallow model errors — propagate so the caller
  // (pipeline / voter) can decide whether to skip the page or fail the doc.
  if (!ok) throw new Error(error ?? "vision inference failed");
  return { profile: parseProfileReply(output), reply: output };
}

/**
 * Tally parsed profiles across several classifier replies and pick the winner
 * (S4). Ties are broken by specificity — ALL_PROFILES order is
 * paper > slides > poster > diagram > image — so the generic "image" fallback
 * loses ties. Empty input -> "image".
 */
export function voteProfile(replies: string[]): DocProfile {
  if (replies.length === 0) return "image";
  const counts = new Map<DocProfile, number>();
  for (const r of replies) {
    const p = parseProfileReply(r);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  let best: DocProfile = "image";
  let bestCount = -1;
  // Iterate in specificity order; strict `>` keeps the earlier (more specific)
  // profile on ties.
  for (const p of ALL_PROFILES) {
    const c = counts.get(p) ?? 0;
    if (c > bestCount) {
      best = p;
      bestCount = c;
    }
  }
  return best;
}

/**
 * Classify a document by voting across representative page images (S4).
 * Each page is classified independently via classifyProfileViaVlm; the
 * majority wins (voteProfile). Per-page errors are skipped so one bad page
 * doesn't sink classification. Throws only if EVERY sampled page fails.
 */
export async function classifyProfileFromPages(
  images: { path: string; mimeType: string }[],
  llmOverride?: ResolvedLLM,
  signal?: AbortSignal,
): Promise<{ profile: DocProfile; replies: string[] }> {
  const replies: string[] = [];
  for (const img of images) {
    try {
      const { reply } = await classifyProfileViaVlm(img.path, img.mimeType, llmOverride, signal);
      if (reply) replies.push(reply);
    } catch {
      // skip a page that failed to classify
    }
  }
  if (replies.length === 0) {
    throw new Error("all sampled pages failed to classify");
  }
  return { profile: voteProfile(replies), replies };
}
