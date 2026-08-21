/** Runtime configuration for s2-agent-ext-compact, parsed once from env. */
export interface CompactConfig {
  /** BUN_PI_COMPACT=0 disables the extension entirely (scaffold self-gate convention). */
  enabled: boolean;
  /** "provider/model-id[:thinking]" overriding the session model for summarization. */
  modelOverrideSpec: string | undefined;
  /** Fraction of reserveTokens usable for the summary (host built-in uses 0.8). */
  maxTokensFactor: number;
}

export function loadCompactConfig(
  env: Record<string, string | undefined> = process.env,
): CompactConfig {
  const raw = Number.parseFloat(env.COMPACT_MAX_TOKENS_FACTOR ?? "");
  const factor = Number.isFinite(raw) ? Math.min(1, Math.max(0.1, raw)) : 0.8;
  return {
    enabled: env.BUN_PI_COMPACT !== "0",
    modelOverrideSpec: env.COMPACT_MODEL?.trim() || undefined,
    maxTokensFactor: factor,
  };
}
