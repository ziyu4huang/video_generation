/** Pure helpers for the offline A/B replay harness (scripts/ab.ts). */

export interface SessionCandidate {
  id: string;
  path: string;
  messageEntries: number;
  bytes: number;
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
