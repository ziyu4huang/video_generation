/** Pure helpers for the offline A/B replay harness (scripts/ab.ts). */

export interface SessionCandidate {
  id: string;
  path: string;
  messageEntries: number;
  bytes: number;
  /** chars/4 estimate of the serialized conversation (cheap pre-read); undefined = unknown. */
  estimatedTokens?: number;
}

export function selectSessions(
  candidates: readonly SessionCandidate[],
  opts: { minMessages: number; n: number },
): SessionCandidate[] {
  return candidates
    .filter((c) => c.messageEntries >= opts.minMessages)
    .sort((a, b) => b.messageEntries - a.messageEntries)
    .slice(0, opts.n);
}

/** Fallback usable-context budget when the registry gives no usable context window. */
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 60_000;
/** Conservative fraction of the context window allowed for the summarization prompt. */
export const CONTEXT_WINDOW_FRACTION = 0.5;

/** Usable prompt-token budget for one summarization call (fraction of the model's context window). */
export function maxPromptTokens(model: { contextWindow?: number } | undefined): number {
  const window =
    model?.contextWindow && Number.isFinite(model.contextWindow) && model.contextWindow > 0
      ? model.contextWindow
      : FALLBACK_CONTEXT_WINDOW_TOKENS;
  return Math.floor(window * CONTEXT_WINDOW_FRACTION);
}

/** Split candidates into runnable vs over-budget; unknown estimates are kept. */
export function partitionByTokenBudget(
  candidates: readonly SessionCandidate[],
  budgetTokens: number,
): { kept: SessionCandidate[]; skipped: Array<{ id: string; reason: string }> } {
  const kept: SessionCandidate[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const c of candidates) {
    if (c.estimatedTokens !== undefined && c.estimatedTokens > budgetTokens) {
      skipped.push({ id: c.id, reason: `~${c.estimatedTokens}tok > ${budgetTokens}tok prompt budget` });
    } else {
      kept.push(c);
    }
  }
  return { kept, skipped };
}

export interface MetricsInput {
  tokensBefore: number;
  summaryTokens: number;
  summarizedEntryTokens: number;
  wallMs: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}

export interface ArmMetrics {
  summaryTokens: number;
  wallMs: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** tokensAfter ≈ tokensBefore − summarizedEntryTokens + summaryTokens; ratio = before/after. */
  compressionRatio: number;
}

export function computeMetrics(input: MetricsInput): ArmMetrics {
  const tokensAfter = input.tokensBefore - input.summarizedEntryTokens + input.summaryTokens;
  return {
    summaryTokens: input.summaryTokens,
    wallMs: input.wallMs,
    inputTokens: input.usage.input,
    outputTokens: input.usage.output,
    cost: input.usage.cost,
    compressionRatio: tokensAfter > 0 ? input.tokensBefore / tokensAfter : Number.POSITIVE_INFINITY,
  };
}

export function extractErrorStrings(conversationText: string, cap = 20): string[] {
  const out: string[] = [];
  for (const line of conversationText.split("\n")) {
    if (out.length >= cap) break;
    if (/(Error|error):/.test(line) || /\bfailed\b|FAILED|Traceback|✗/.test(line)) {
      const trimmed = line.trim().slice(0, 140);
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}
