/**
 * Per-profile system prompts + page-level explanation via a pi-agent session.
 *
 * Design:
 *  - Each `DocProfile` ("paper", "image", …) maps to a system prompt that
 *    instructs the VLM how to turn ONE page image into structured Obsidian
 *    markdown (frontmatter + body + a wikilink to the source PNG).
 *  - The orchestrator calls `explainPage()` once per page, feeding the PNG as
 *    an image attachment to the model via `session.prompt(text, { images })`.
 *
 * The model defaults to `lm-studio/google/gemma-4-12b` (a vision-capable
 * Gemma served locally). Override with --model / --provider / --thinking.
 *
 * Output markdown shape (Obsidian-compatible):
 *
 *   ---
 *   title: <slug> — Page N
 *   doc: "[[<slug>]]"
 *   page: N
 *   kind: paper
 *   ---
 *
 *   ## <Section heading or "Page N">
 *
 *   ![[page-001.png]]
 *
 *   <markdown transcription / summary of the page content>
 */
import { readFileSync } from "node:fs";
import type { ResolvedLLM } from "../sessions.ts";
import type { DocProfile } from "./classify.ts";
import { imageMimeType } from "./classify.ts";
import { runVisionInference } from "./vision-inference.js";

/** Output processing mode: how literally to transcribe vs summarize (T3). */
export type ExplainMode = "summary" | "verbatim" | "hybrid";

/** Options for building a per-profile system prompt. */
export interface PromptOpts {
  /** Output language code/label (default "zh-TW"). */
  lang?: string;
  /** Processing mode (default "hybrid"). */
  mode?: ExplainMode;
}

/** Human label for a language code. */
function langLabel(lang: string): string {
  const l = lang.toLowerCase();
  if (l === "zh-tw" || l === "zh" || l === "zh_tw" || l === "traditional-chinese") return "繁體中文";
  if (l === "en" || l === "english") return "English";
  return lang;
}

/** Short phrase describing a processing mode. */
function modePhrase(mode: ExplainMode): string {
  switch (mode) {
    case "verbatim":
      return "忠實謄寫（盡可能逐字保留原文，僅做格式化、不濃縮）";
    case "summary":
      return "摘要整理（濃縮重點）";
    case "hybrid":
    default:
      return "整理與摘要";
  }
}

/**
 * Common frontmatter/footer rules shared by all profiles. Parametric on output
 * language + processing mode (T3) — previously hardcoded 繁中 / hybrid. Also
 * carries the S3 few-shot format example (closed frontmatter + bracket-free
 * embed) that prevents the recurring defects normalize* otherwise repairs.
 */
function commonRules(lang: string, mode: ExplainMode): string {
  return `
共同規則：
- 輸出語言：${langLabel(lang)}。處理方式：${modePhrase(mode)}；但忠實度優先——定義、方法步驟、演算法、實驗設定與數據、關鍵引用，一律原樣保留原文（可直接原文引述），避免因翻譯或過度濃縮而流失資訊。專有名詞、人名、術語、公式保留原文。
- 輸出「純 Markdown」：不要用程式碼區塊包裹（不要 \`\`\`markdown），不要任何前置說明文字，直接從 --- 開始。
- 開頭必須是 YAML frontmatter（--- 包夾），欄位：
  - title：本頁標題
  - doc：文件層級索引筆記的 wikilink，格式 [[<docSlug>]]
  - page：頁碼（數字）
  - kind：<profile 代碼>
- frontmatter 後空一行，放一行原始圖片的 Obsidian 圖片嵌入；每頁訊息會給你確切的 \`![[檔名]]\`，請「原樣輸出該行」，不要增刪引號、角括號或空白。
- 圖片嵌入後空一行，再開始正文。
- 忠於原圖，不捏造圖中沒有的內容；模糊處標註「（模糊不可讀）」。

格式範例（只參考「形狀」，內容依實際頁面填寫；範例開始↓）：
---
title: 本頁標題
doc: [[doc-slug]]
page: 1
kind: paper
---

![[page-001.png]]

（正文：依輸出語言整理本頁內容……）
（範例結束↑）

關鍵：frontmatter 必須用第二個 --- 關閉；圖片嵌入一律 ![[檔名]]，不可加角括號 <>。`;
}

/** Per-profile intro line. */
const PROFILE_INTRO: Record<DocProfile, string> = {
  paper: "你是一個專門把學術論文 PDF 頁面轉成結構化 Obsidian 筆記的 VLM 助理。",
  slides: "你是一個把簡報投影片轉成結構化 Obsidian 筆記的 VLM 助理。",
  poster: "你是一個把學術/會議海報轉成結構化 Obsidian 筆記的 VLM 助理。",
  diagram: "你是一個把圖表 / 流程圖 / 架構圖轉成結構化 Obsidian 筆記的 VLM 助理。",
  image: "你是一個把單張圖片內容轉成結構化 Obsidian 筆記的 VLM 助理。",
};

/** Per-profile extra rules (appended after the shared common rules). */
const PROFILE_RULES: Record<DocProfile, string> = {
  paper: `- kind 欄位固定為 paper。
- 額外加 section 欄位：本頁主要章節（Abstract / Introduction / Related Work / Method / Experiments / Results / Conclusion / References；若無明確章節則寫 Body）。
- 正文內容依頁面類型：
  - 首頁：論文標題、作者、機構、完整摘要（忠實謄寫或改寫）。
  - 內文：濃縮重點，保留關鍵公式（內聯 $...$ 或區塊 $$...$$）、圖表標題與大意、實驗設定與數據結論。
  - 參考文獻：列出該頁條目（作者、年份、標題、出處，可精簡）。`,
  slides: `- kind 欄位固定為 slides。
- title 用該張投影片的大標題。
- 正文：逐條謄寫投影片上的條列重點；若有圖表說明其類型與要點；補上該頁想傳達的核心論點。`,
  poster: `- kind 欄位固定為 poster。
- 正文依海報區塊（如 Abstract / Introduction / Methods / Results / Conclusion）分段整理；圖表逐一說明標題與結論。`,
  diagram: `- kind 欄位固定為 diagram。
- 正文：說明圖的類型與目的；以文字還原流程/架構（可用條列或巢狀清單）；記錄所有標籤、節點、箭頭方向與註解。若有數學式則用 LaTeX。`,
  image: `- kind 欄位固定為 image。
- page 恆為 1。
- 正文：描述圖片內容（若有文字則忠實謄寫；若有圖表則說明類型與要點；若為照片則描述場景與細節）。`,
};

/** Resolve the system prompt for a profile, parametric on lang/mode (T3). */
export function systemPromptFor(profile: DocProfile, opts: PromptOpts = {}): string {
  const lang = opts.lang ?? "zh-TW";
  const mode = opts.mode ?? "hybrid";
  const intro = PROFILE_INTRO[profile] ?? PROFILE_INTRO.image;
  const rules = PROFILE_RULES[profile] ?? PROFILE_RULES.image;
  return `${intro}\n\n${commonRules(lang, mode)}\n${rules}`;
}

/** Read an image file into a base64 ImageContent block (pi-ai schema). */
export function readImageContent(abs: string, mimeType: string): { type: "image"; data: string; mimeType: string } {
  const buf = readFileSync(abs);
  const data = Buffer.from(buf).toString("base64");
  return { type: "image", data, mimeType };
}

/**
 * Repair VLM-emitted Obsidian image embeds. Some VLMs echo the per-page embed
 * with stray placeholder delimiters — `![[<page-003.png>]]` instead of
 * `![[page-003.png]]` — which breaks the embed in Obsidian. Strip angle
 * brackets (and surrounding spaces) inside `![[ ]]`. Valid embeds are untouched.
 */
export function normalizeEmbeds(md: string): string {
  return md.replace(/!\[\[\s*<+([^>\]]+?)>+\s*\]\]/g, (_m, inner) => `![[${String(inner).trim()}]]`);
}

/**
 * Enforce CLI-known frontmatter fields the VLM may get wrong, and repair
 * structurally broken frontmatter. Handles three cases:
 *  1. Well-formed (closed) frontmatter — override `page`/`kind`.
 *  2. UNCLOSED frontmatter — the VLM emitted the opening `---` + key:value
 *     fields but forgot the closing `---` (a recurring gemma defect that makes
 *     Obsidian refuse to parse the frontmatter). Collect the leading
 *     key:value lines, close the block, then override `page`/`kind`.
 *  3. No frontmatter — return unchanged (never invent one).
 */
export function normalizeFrontmatter(md: string, known: { page: number; kind: string }): string {
  const override = (body: string): string =>
    body.replace(/^(\s*page\s*:\s*).*/m, `$1${known.page}`).replace(/^(\s*kind\s*:\s*).*/m, `$1${known.kind}`);

  // Must open with `---` on its own first line.
  const open = /^---\r?\n/.exec(md);
  if (!open) return md;

  // Collect the contiguous leading key:value lines = the frontmatter fields.
  // Stop at the first blank line or non-field line, so a stray `---` (e.g. a
  // thematic break) later in the body is never mistaken for the closer.
  const lines = md.slice(open[0].length).split(/\r?\n/);
  const kv = /^\s*[\w.-]+\s*:\s*.+/;
  const fm: string[] = [];
  let i = 0;
  while (i < lines.length && lines[i]!.trim() !== "" && kv.test(lines[i]!)) {
    fm.push(lines[i]!);
    i++;
  }
  if (fm.length === 0) return md; // leading --- with no fields — leave untouched

  // Skip a redundant closing delimiter the VLM placed right after the fields.
  let j = i;
  if (lines[j] !== undefined && lines[j]!.trim() === "---") j++;

  const body = override(fm.join("\n"));
  const remainder = lines.slice(j).join("\n");
  return `---\n${body}\n---\n${remainder}`;
}

/** Build the per-page user message (replaces the <placeholders> in the system prompt context). */
export function pageUserMessage(opts: {
  docSlug: string;
  page: number;
  pngLinkName: string;
  pageCount: number;
  /** Optional cross-page context line (S1). Omitted on page 1 / single-image docs. */
  priorContext?: string;
}): string {
  const lines = [
    `文件 slug：${opts.docSlug}`,
    `這是第 ${opts.page} 頁（共 ${opts.pageCount} 頁）。`,
    `圖片嵌入（原樣輸出此行，勿加角括號）：![[${opts.pngLinkName}]]`,
  ];
  if (opts.priorContext) lines.push("", opts.priorContext);
  lines.push("", "請依系統提示的格式，把這一頁轉成 Obsidian markdown。");
  return lines.join("\n");
}

/** Re-export for the command layer's convenience. */
export { imageMimeType };

/** Result of explaining a single page. */
export interface ExplainResult {
  markdown: string;
  ok: boolean;
  error?: string;
}

/**
 * Explain ONE page image via a fresh VLM session (one turn, then disposed).
 *
 * The profile selects the system prompt; the PNG is attached as an image.
 * Returns the assistant's raw markdown text.
 *
 * @param llm      resolved LLM target
 * @param profile  content profile (selects system prompt)
 * @param page     page image + context
 */
export async function explainPage(
  llm: ResolvedLLM,
  profile: DocProfile,
  page: {
    imageAbs: string;
    mimeType: string;
    pngLinkName: string;
    docSlug: string;
    pageNo: number;
    pageCount: number;
    /** Optional cross-page context line (S1) from prior pages. */
    priorContext?: string;
    /** Output language (T3, default zh-TW). */
    lang?: string;
    /** Processing mode (T3, default hybrid). */
    mode?: ExplainMode;
  },
): Promise<ExplainResult> {
  const image = readImageContent(page.imageAbs, page.mimeType);
  const userMsg = pageUserMessage({
    docSlug: page.docSlug,
    page: page.pageNo,
    pngLinkName: page.pngLinkName,
    pageCount: page.pageCount,
    priorContext: page.priorContext,
  });

  const { output, ok, error } = await runVisionInference({
    task: userMsg,
    images: [image],
    llm,
    systemPrompt: systemPromptFor(profile, { lang: page.lang, mode: page.mode }),
  });

  return ok
    ? {
        markdown: normalizeFrontmatter(normalizeEmbeds(output), {
          page: page.pageNo,
          kind: profile,
        }),
        ok: true,
      }
    : { markdown: "", ok: false, error };
}
