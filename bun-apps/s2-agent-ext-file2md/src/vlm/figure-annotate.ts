import type { ResolvedLLM } from "../sessions.ts";
import { askImage } from "./ask.ts";

const SYSTEM = [
  "You are a figure-and-equation annotator for a text-only agent.",
  "The body text is already extracted (provided as PRIOR) — do NOT restate it.",
  "Describe the figure(s) on the page faithfully and in enough detail to be",
  "understood without seeing them, and render any named equation in LaTeX.",
  "Be faithful to the PRIOR for equations; do not invent symbols.",
].join(" ");

export function buildPriorPrompt(priorText: string, pageNo: number): string {
  return [
    `PRIOR (text already extracted from page ${pageNo}, treat as ground truth — do NOT restate the body prose):`,
    '"""',
    priorText,
    '"""',
    "",
    "TASK (output ONLY these):",
    "1. FIGURE description — describe every figure on this page in detail (components, flow, labels).",
    "2. EQUATION(s) — render each equation shown on this page in clean LaTeX, faithful to the PRIOR.",
  ].join("\n");
}

export interface FigureAnnotateArgs {
  imageAbs: string;
  priorText: string;
  pageNo: number;
  mimeType?: string;
}

export interface FigureAnnotateResult {
  ok: boolean;
  markdown: string;
  error?: string;
}

export async function describeFigureWithPrior(
  llm: ResolvedLLM,
  args: FigureAnnotateArgs,
): Promise<FigureAnnotateResult> {
  const r = await askImage(args.imageAbs, buildPriorPrompt(args.priorText, args.pageNo), {
    systemPrompt: SYSTEM,
    llm,
    mimeType: args.mimeType,
  });
  return r.ok ? { ok: true, markdown: r.reply } : { ok: false, markdown: "", error: r.error };
}
