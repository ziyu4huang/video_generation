/**
 * Per-session throttle for errorCapture: a sliding-window rate limit + an
 * in-memory LRU of this-session dedup keys. Pure logic — no I/O, no
 * config/env awareness (construction takes plain numbers).
 *
 * Two-phase contract (see error-detector data flow):
 *   - allow(key) GATES (false if this-session dup ① OR window full ③) but
 *     does NOT record.
 *   - recordCapture(key) is called by the detector ONLY after a successful
 *     write, so rate slots + cache are consumed solely by real writes. Thus
 *     cross-session duplicates (caught by the store-check ②) do not eat the
 *     rate budget and cannot starve genuinely novel captures.
 *
 * Fail-open: any internal error in allow() returns true (never blocks a
 * lesson-worthy capture due to a throttle bug).
 */
export interface CaptureThrottleOptions {
  /** Max captures per window. 0 = unlimited (no rate cap). */
  rateLimit: number;
  /** Sliding-window length in ms. */
  rateWindowMs: number;
  /** LRU capacity for this-session dedup keys. 0 = no fast-path. */
  dedupCacheSize: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

export class CaptureThrottle {
  private readonly rateLimit: number;
  private readonly rateWindowMs: number;
  private readonly dedupCacheSize: number;
  private readonly now: () => number;
  private readonly timestamps: number[] = [];
  private readonly cache: Map<string, true> = new Map();

  constructor(opts: CaptureThrottleOptions) {
    this.rateLimit = Math.max(0, Math.floor(opts.rateLimit));
    this.rateWindowMs = Math.max(0, opts.rateWindowMs);
    this.dedupCacheSize = Math.max(0, Math.floor(opts.dedupCacheSize));
    this.now = opts.now ?? (() => Date.now());
  }

  /** Drop timestamps older than the sliding window. */
  private pruneWindow(): void {
    const cutoff = this.now() - this.rateWindowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
  }

  /**
   * Gate check BEFORE the store-check/write. Returns false iff:
   *   ① the key is in this-session dedup cache, OR
   *   ③ the sliding-window count is already at rateLimit.
   * Fail-open: on any internal error, returns true.
   */
  allow(key: string): boolean {
    try {
      if (this.dedupCacheSize > 0 && this.cache.has(key)) return false; // ①
      if (this.rateLimit > 0) {
        this.pruneWindow();
        if (this.timestamps.length >= this.rateLimit) return false; // ③
      }
      return true;
    } catch {
      return true; // fail-open
    }
  }

  /**
   * Record a successful capture: push a timestamp + LRU-insert the key
   * (evicting the oldest key if over capacity). Call only after a real write.
   */
  recordCapture(key: string): void {
    this.timestamps.push(this.now());
    if (this.dedupCacheSize > 0) {
      this.cache.delete(key); // LRU touch: re-insert as newest
      this.cache.set(key, true);
      while (this.cache.size > this.dedupCacheSize) {
        const oldest = this.cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }
  }
}
