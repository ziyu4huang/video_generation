/**
 * Contradiction judge (Plan 5a — supersession auto-trigger, judge-gated).
 *
 * Given a user correction + candidate recalled memories, an LLM returns the
 * SINGLE candidate the correction contradicts (or null). Uses the DIRECT
 * `completeSimple` path (structured JSON), mirroring
 * `review-memory-ops.ts`'s `runDirectBackgroundReview` — NOT `spawn` (free
 * text). Only the pure parser is unit-tested; the `completeSimple` call is
 * integration-level and exercised via the fake judge in Task 2.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple, type Message } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryEntry } from "../store/repository.js";
import type { MemoryConfig } from "../types.js";
import {
  buildDirectReviewCompletionOptions,
  effectiveThinkingOverride,
  extractJsonPayload,
  resolveReviewModel,
  responseText,
} from "./review-memory-ops.js";

export const CONTRADICTION_JUDGE_SYSTEM_PROMPT = `You judge whether a user's correction contradicts a stored memory.
Given a correction and a list of candidate memories (each with an id and content), return JSON: {"contradicted_id": <number|null>, "reason": "<short>"}
- Set contradicted_id to the SINGLE candidate id whose content the correction directly refutes/corrects. The candidate may be any target (memory/user/failure).
- If no candidate is contradicted, set contradicted_id to null.
- Output ONLY the JSON object.`;

/** Pure: parse + validate the judge's JSON verdict. Returns null if malformed. */
export function parseContradictionVerdict(raw: unknown): { contradictedId: number | null } | null {
  const json = typeof raw === "string" ? extractJsonPayload(raw) : raw;
  if (!json || typeof json !== "object") return null;
  const id = (json as { contradicted_id?: unknown }).contradicted_id;
  if (id === null) return { contradictedId: null };
  if (typeof id === "number" && Number.isFinite(id)) return { contradictedId: id };
  return null;
}

export type ContradictionJudgeCtx = Pick<ExtensionContext, "model" | "modelRegistry">;

export interface ContradictionJudgeInput {
  correctionText: string;
  /** Already active-filtered by searchMemories (superseded entries excluded). */
  candidates: MemoryEntry[];
  config: Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride">;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Returns the single contradicted candidate id, or null (no contradiction /
 * unavailable / parse-fail). NEVER throws — the caller wraps this best-effort.
 */
export async function runContradictionJudge(
  ctx: ContradictionJudgeCtx,
  input: ContradictionJudgeInput,
): Promise<{ contradictedId: number | null }> {
  try {
    const model = resolveReviewModel(ctx.model, ctx.modelRegistry, input.config);
    if (!model) return { contradictedId: null };

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return { contradictedId: null };

    const controller = new AbortController();
    const timeoutMs = input.timeoutMs ?? 30000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    if (input.signal) {
      input.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    const thinking = effectiveThinkingOverride(input.config);
    const candidateBlock = input.candidates
      .map((candidate) => `- id=${candidate.id}: ${candidate.content}`)
      .join("\n");
    const userMessage: Message = {
      role: "user",
      content: [
        {
          type: "text",
          text: `Correction: ${input.correctionText}\n\nCandidates:\n${candidateBlock}`,
        },
      ],
      timestamp: Date.now(),
    };

    try {
      const response = await completeSimple(
        model,
        { systemPrompt: CONTRADICTION_JUDGE_SYSTEM_PROMPT, messages: [userMessage] },
        buildDirectReviewCompletionOptions(
          model,
          { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
          thinking,
          controller.signal,
        ),
      );

      const text = responseText(response.content);
      return parseContradictionVerdict(text) ?? { contradictedId: null };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return { contradictedId: null }; // never throw — caller wraps best-effort anyway
  }
}
