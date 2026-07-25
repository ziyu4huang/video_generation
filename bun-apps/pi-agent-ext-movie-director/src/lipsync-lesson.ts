/**
 * lipsync-lesson.ts — builds a structured lesson from a lipsync_metrics
 * verdict, shaped to map 1:1 onto hermes-memory's `memory` tool call
 * (`target`, `category`, `content`, `reason`). Pure: no I/O, no hermes-memory
 * dependency — the agent is the one that calls the memory tool, this module
 * only decides what to say.
 */
export interface LipsyncLesson {
  target: "failure" | "memory";
  category: "tool-quirk" | "insight";
  content: string;
  reason?: string;
}

export interface LipsyncLessonInput {
  verdict: string;
  pearsonR: number | null;
  mouthRatioStd: number | null;
  seed?: number;
  promptSummary?: string;
  identityRef?: string;
  voice?: string;
  caveat?: string;
}

export function buildLipsyncLesson(input: LipsyncLessonInput): LipsyncLesson {
  const who = [input.identityRef, input.voice].filter(Boolean).join(" / ") || "unknown identity";
  const params = [
    input.seed !== undefined ? `seed=${input.seed}` : null,
    input.promptSummary ? `prompt="${input.promptSummary}"` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const metrics = `pearson_r=${input.pearsonR ?? "n/a"}, mouth_ratio_std=${input.mouthRatioStd ?? "n/a"}`;
  const paramsSuffix = params ? ` (${params})` : "";

  if (input.verdict === "adequate") {
    return {
      target: "memory",
      category: "insight",
      content: `Lipdub combo works: ${who}${paramsSuffix} -> ${metrics}.`,
    };
  }

  if (input.verdict === "inadequate") {
    return {
      target: "failure",
      category: "tool-quirk",
      content: `Lipdub combo fails: ${who}${paramsSuffix} -> ${metrics}.`,
      reason: input.caveat ?? `verdict=${input.verdict}`,
    };
  }

  // Any other verdict (no_face, no_audio, sync_venv_missing, bridge_error,
  // weights_missing, no_frames, too_short, inference_error, or an unknown
  // future value) means the evaluation itself did not complete — NOT
  // evidence that this seed/prompt/identity combo produces bad lip-sync.
  // Worded distinctly from the "inadequate" case so it isn't misread later
  // as a quality judgment when it's actually a setup/measurement failure.
  return {
    target: "failure",
    category: "tool-quirk",
    content: `Lipdub evaluation inconclusive (verdict=${input.verdict}): ${who}${paramsSuffix} -> ${metrics}. Not a quality judgment on this combo — the evaluation itself didn't complete.`,
    reason: input.caveat ?? `verdict=${input.verdict}`,
  };
}
