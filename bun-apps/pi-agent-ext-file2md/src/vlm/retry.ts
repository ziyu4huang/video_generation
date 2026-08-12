/**
 * Retry wrapper for VLM calls (and other flaky model calls).
 *
 * Strategy:
 *   - 429 (rate limit) / 5xx / transient network errors → retry with fixed wait.
 *   - Other errors (bad request, model crash, parse error) → fail fast, no retry.
 *
 * Defaults match the `pdf-to-vault` pipeline contract:
 *   maxRetries = 3, retryWaitMs = 10_000 (configurable via flags).
 */

/** Heuristic: is this error retryable? */
export function isRetryableError(err: unknown): boolean {
  // Explicit opt-in: callers can mark an error retryable (e.g. a VLM output
  // that failed a quality gate — a stochastic model deserves another attempt).
  if ((err as { retryable?: boolean })?.retryable === true) return true;
  const msg = (err as { message?: string })?.message ?? (typeof err === "string" ? err : String(err));
  const status =
    (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode;
  // 429 rate limit
  if (status === 429) return true;
  // 5xx server errors
  if (typeof status === "number" && status >= 500 && status < 600) return true;
  // message-based detection (providers surface 429 as text)
  return /rate[\s_-]?limit|429|too many requests|overloaded|service unavailable|timeout|timed out|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i.test(
    msg,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Build an error explicitly marked retryable. Used by callers that want a
 * failure (e.g. a VLM page failing the output quality gate) to be retried by
 * `withRetry` regardless of its message — a stochastic model may succeed on a
 * later attempt. The `retryable: true` property is honored by `isRetryableError`.
 */
export function retryableError(message: string): Error & { retryable: true } {
  return Object.assign(new Error(message), { retryable: true as const });
}

export interface RetryOptions {
  /** Number of retries AFTER the initial attempt (default 3 → up to 4 total calls). */
  maxRetries?: number;
  /** Wait between retries, in ms (default 10_000). */
  retryWaitMs?: number;
  /** Optional logger for retry notices. */
  onRetry?: (info: { attempt: number; maxRetries: number; waitMs: number; error: unknown }) => void;
}

/**
 * Run `fn`, retrying on retryable errors.
 *
 * @returns the result of `fn`
 * @throws  the last error if all attempts fail, or immediately on non-retryable error
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const retryWaitMs = opts.retryWaitMs ?? 10_000;

  let lastErr: unknown;
  // initial attempt + retries
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt === maxRetries) throw err;
      opts.onRetry?.({ attempt: attempt + 1, maxRetries, waitMs: retryWaitMs, error: err });
      await sleep(retryWaitMs);
    }
  }
  // unreachable, but satisfies TS
  throw lastErr;
}
