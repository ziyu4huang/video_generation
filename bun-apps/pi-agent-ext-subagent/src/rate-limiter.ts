/**
 * Process-global, per-provider concurrency limiter — the SHARED outer cap that
 * BOTH `subagents`/`subagent` (this package) and `workflow` agent dispatch
 * (pi-agent-ext-workflow) acquire. Without it the two tools own DISJOINT
 * limiters — `subagents`: a per-batch worker pool; `workflow`: a per-run-tree
 * counting semaphore — so their COMBINED provider dispatch blows past the
 * provider's rate limit and crashes. This single shared budget, keyed by
 * provider, bounds the SUM across both tools.
 *
 * == Sharing mechanism ==
 * A single state object lives on `globalThis.__piRateLimitState`, holding the
 * provider→limiter Map AND the config resolver. This GUARANTEES one limiter
 * instance per provider per process regardless of how the workspace linker
 * dedupes module records between pi-agent-ext-subagent and
 * pi-agent-ext-workflow: even if the two packages resolved to SEPARATE module
 * instances (which would fork a module-level singleton into two), they still
 * read/write the SAME globalThis slot. The cross-package sharing test
 * (tests/rate-limiter-cross-pkg.test.ts) acquires-and-holds via the deep src
 * import path, then proves the package-root import path BLOCKS on the same
 * budget.
 *
 * The workflow extension owns the `rateLimits` config schema, so it registers
 * the resolver once at load (settings read at boot, mirroring defaultConcurrency).
 * Both packages acquire via `getGlobalRateLimiter(provider).run(fn)`. When no cap
 * is configured for a provider, `run` is a PASS-THROUGH (no gating, no
 * bookkeeping) so behavior is byte-identical to before until the user opts in.
 *
 * == Where it runs ==
 * Outside the workflow vm (plain TS orchestrator layer). A counting semaphore
 * needs no clock, and the vm neuters Date.now() — so this must NOT live in
 * workflow script space.
 */

const GLOBAL_KEY = "__piRateLimitState" as const;

/** Config resolver: provider → clamped maxConcurrent, or undefined (pass-through). */
export type RateLimitCapResolver = (provider: string) => number | undefined;

interface RateLimitState {
  /** provider key → the one shared limiter for that provider. */
  limiters: Map<string, RateLimiter>;
  /** Registered by whichever package owns the rateLimits config (workflow). */
  resolver: RateLimitCapResolver | undefined;
}

function getState(): RateLimitState {
  const g = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = g[GLOBAL_KEY];
  if (existing && typeof existing === "object") return existing as RateLimitState;
  const state: RateLimitState = { limiters: new Map(), resolver: undefined };
  g[GLOBAL_KEY] = state;
  return state;
}

export interface RateLimiter {
  /** The provider this limiter bounds (the rateLimits config key). */
  readonly provider: string;
  /**
   * Run `fn` gated by the provider's configured cap. Pass-through (fn runs
   * ungated, with no bookkeeping) when no cap is configured for the provider,
   * so behavior is unchanged until the user opts in via rateLimits config.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Counting semaphore bounded by a dynamically-resolved cap. Mirrors workflow's
 * proven `createLimiter` (active counter + FIFO queue), plus a pass-through fast
 * path when the cap is unset. The cap is re-read per `run()` via the resolver;
 * in practice the resolver returns a stable config value, so a limiter's
 * effective capacity does not change mid-flight.
 */
function createRateLimiter(provider: string, state: RateLimitState): RateLimiter {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    active--;
    // Wake exactly one waiter; that waiter resumes past its await and does
    // active++. Mirrors workflow's createLimiter `next()` exactly.
    queue.shift()?.();
  };
  return {
    provider,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const cap = state.resolver?.(provider);
      // Unconfigured provider → pass-through: no gating, no accounting.
      if (cap === undefined) return fn();
      if (active >= cap) await new Promise<void>((resolve) => queue.push(resolve));
      active++;
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

/**
 * The single shared limiter for a provider (lazy-created, process-global via the
 * globalThis state). Callers in BOTH pi-agent-ext-subagent and
 * pi-agent-ext-workflow resolve the same instance for a given provider.
 */
export function getGlobalRateLimiter(provider: string): RateLimiter {
  const state = getState();
  let limiter = state.limiters.get(provider);
  if (!limiter) {
    limiter = createRateLimiter(provider, state);
    state.limiters.set(provider, limiter);
  }
  return limiter;
}

/**
 * Register the config→cap resolver. The workflow extension owns the rateLimits
 * schema, so it registers this once at load. Idempotent; the latest registration
 * wins. Pass undefined to clear (reverts every provider to pass-through).
 */
export function setRateLimitCapResolver(resolver: RateLimitCapResolver | undefined): void {
  getState().resolver = resolver;
}

/** Read the currently-registered resolver (introspection / tests). */
export function getRateLimitCapResolver(): RateLimitCapResolver | undefined {
  return getState().resolver;
}

/** Reset the global state — tests ONLY (clears limiters + resolver). */
export function __resetRateLimitStateForTests(): void {
  const state = getState();
  state.limiters.clear();
  state.resolver = undefined;
}

/**
 * Derive the provider key from a `provider/model-id` spec (the segment before
 * the first '/'). Returns undefined for an empty/unscoped spec so the caller can
 * skip the limiter entirely (pass-through) when the session model is unknown.
 */
export function providerFromModelSpec(modelSpec: string | undefined): string | undefined {
  if (!modelSpec) return undefined;
  const idx = modelSpec.indexOf("/");
  const provider = idx === -1 ? modelSpec : modelSpec.slice(0, idx);
  return provider || undefined;
}
