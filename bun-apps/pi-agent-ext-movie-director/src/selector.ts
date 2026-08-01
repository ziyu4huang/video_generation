/**
 * selector.ts — pick a configured provider for a capability.
 *
 * The registry's `invoke` field names the bridge strategy; this module is the
 * decision layer that turns a capability request ("I need an image") into a
 * concrete, callable ProviderEntry. The deterministic ranking prefers the
 * local native stack (swift/MLX → ffmpeg → macOS → cloud), breaking ties by
 * registry order so the choice never depends on map iteration order.
 *
 * An explicit `provider` hint always wins when it names a configured provider
 * for the capability (the agent can force "use flux2 for this image"). If the
 * hint names a provider that is NOT configured (or not in this capability), it
 * is ignored and the ranking falls back — this is a soft hint, not a hard pin,
 * so a stale hint never blocks generation.
 *
 * Override precedence, highest to lowest (tool-design audit, 2026-07-12 —
 * documented explicitly here because the correct behavior previously required
 * reading `selectProvider` top-to-bottom in exact source order to infer it):
 *
 *   1. Explicit-hint-static — `opts.provider` naming a STATICALLY-configured
 *      provider (`p.configured`, independent of the runtime probe). See the
 *      first `if (opts.provider)` block below.
 *   2. Command-routing — `opts.command` naming a subcommand a configured
 *      (probe-passing) provider declares in `commands` (e.g. `analysis` +
 *      `video_understand` → clip, not whisper). See the `if (opts.command)`
 *      block below.
 *   3. Backend-rank tiebreak — `BACKEND_RANK` order (native_swift → ffmpeg →
 *      macos_native → cloud_http), registry declaration order breaking ties.
 *      The fallback when neither of the above applies. Entries with
 *      `optIn: true` are excluded from this tier entirely (unless they are
 *      the ONLY configured candidates left) — added 2026-08-01 so a
 *      genuinely-better native provider (e.g. kokoro_tts) can ship without
 *      silently becoming every existing bare caller's new default; it only
 *      changes behavior for callers that explicitly ask for it via tier 1/2.
 *
 * A FOURTH override layer exists OUTSIDE this module entirely, at
 * runtime, after this function has already returned: `bridge.ts`'s
 * `selectAndGenerate` opportunistically tries edge-tts before falling back to
 * this module's `say` pick for the `tts` capability (only when the caller
 * didn't pin a provider). It is NOT reflected in this function's return value
 * — the entry `selectProvider` picks and the entry that actually generates
 * can differ, which is exactly what made "just pin the resolved provider"
 * unsafe as a fix for the cost-log tool-attribution drift (Item 3,
 * `output/next-goal-20260712_135012.md`; see `dispatch.ts`'s `generate` case,
 * which calls `retagTool` after `selectAndGenerate` returns, for how that
 * drift is corrected after the fact).
 */
import { REGISTRY, getByCapability, type Capability, type ProviderBackend, type ProviderEntry } from "./registry.ts";
import { probeConfigured } from "./providers.ts";

export class NoConfiguredProviderError extends Error {
  constructor(public capability: Capability) {
    super(
      `no configured provider for capability "${capability}". ` +
        `Known: ${getByCapability(capability).map((p) => p.provider).join(", ") || "(none)"}.`,
    );
    this.name = "NoConfiguredProviderError";
  }
}

export interface SelectorOptions {
  /** Explicit provider name; wins if it names a configured provider for the capability. */
  provider?: string;
  /**
   * Director subcommand the caller addressed (e.g. "video_understand", "transcribe").
   * When a configured provider declares `commands` including it, that provider wins
   * — addressing a tool by {capability, command} is the documented shape, so a
   * command match outranks backend-rank/declaration-order. Capabilities whose
   * providers don't declare `commands` are unaffected (today: only `analysis`
   * partitions by command: whisper owns `transcribe`, clip owns `video_understand`).
   */
  command?: string;
  /** Restrict to a backend class (e.g. native_swift). Rarely needed. */
  backend?: ProviderBackend;
  /** Env to probe provider availability against (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

/** Lower = preferred. Local native stack first, cloud last. */
const BACKEND_RANK: Record<ProviderBackend, number> = {
  native_swift: 0,
  ffmpeg: 1,
  macos_native: 2,
  cloud_http: 3,
};

/**
 * Select a provider for a capability. Deterministic: the candidates whose
 * runtime probe passes (probeConfigured — ffmpeg on PATH, cloud key in env,
 * etc.) are ranked by backend preference then by REGISTRY declaration order
 * (stable). Throws NoConfiguredProviderError if nothing is callable.
 */
export function selectProvider(capability: Capability, opts: SelectorOptions = {}): ProviderEntry {
  const env = opts.env ?? process.env;
  const configured = REGISTRY.filter(
    (p) => p.capability === capability && probeConfigured(p, env) && (!opts.backend || p.backend === opts.backend),
  );

  if (opts.provider) {
    // An explicit hint honors a STATICALLY-configured provider even when its
    // runtime probe is currently false — checked BEFORE the "nothing probed"
    // throw below, so a hint still reaches its target when the whole capability
    // is probe-empty (e.g. a fresh checkout with no swift binaries built yet).
    // This preserves the auto-build flow for the swift directors:
    // `provider:"krea2"` reaches krea2 even before its binary is built
    // (runKrea2's ensureBinary builds it on first run), rather than being
    // silently rerouted because the probe hasn't seen the binary yet. Only
    // statically-GAP / configured:false providers (piper, un-keyed cloud,
    // hyperframes) are ignored — those are the soft-hint cases.
    const staticallyConfigured = REGISTRY.filter(
      (p) => p.capability === capability && p.configured && (!opts.backend || p.backend === opts.backend),
    );
    const hit = staticallyConfigured.find((p) => p.provider === opts.provider);
    if (hit) return hit;
    // Soft hint: a non-matching (or statically-GAP) provider name is ignored,
    // falling through to the probe-based ranking below.
  }

  if (configured.length === 0) throw new NoConfiguredProviderError(capability);

  // Command routing: if the caller addressed a subcommand a configured provider
  // explicitly owns, that wins over backend-rank/declaration-order. This is what
  // lets `{capability:"analysis", command:"video_understand"}` reach CLIP without
  // a manual `provider:"clip"` hint (both are native_swift, whisper is declared
  // first, so the prior backend-then-declaration tiebreak always picked whisper).
  // A command no provider declares falls through to today's behavior (soft).
  if (opts.command) {
    const cmd = opts.command;
    const hit = configured.find((p) => p.commands?.includes(cmd));
    if (hit) return hit;
  }

  // Stable sort by backend rank (registry order breaks ties implicitly —
  // Array.prototype.sort is stable in Bun/Node ≥12). configured is non-empty
  // (we threw above). optIn entries are excluded from this bare fallback
  // (tier 3) unless they're the only configured candidates left — an
  // opt-in-only capability must still be selectable by *something* when
  // it's the sole configured option, even though that case doesn't exist
  // for `tts` today (say/edge-tts are always configured).
  const nonOptIn = configured.filter((p) => !p.optIn);
  const pool = nonOptIn.length > 0 ? nonOptIn : configured;
  return [...pool].sort((a, b) => BACKEND_RANK[a.backend] - BACKEND_RANK[b.backend])[0]!;
}

/**
 * All callable providers for a capability, ranked best-first (for menu/UI).
 * Mirrors selectProvider's bare-fallback tier: `optIn: true` entries (e.g.
 * kokoro_tts) are excluded from the ranking — they must never appear as the
 * apparent default/preferred choice in a menu listing — unless they are the
 * ONLY configured candidates left, in which case they're kept so the
 * capability still lists *something*.
 */
export function rankedProviders(capability: Capability, env: Record<string, string | undefined> = process.env): ProviderEntry[] {
  const configured = REGISTRY.filter((p) => p.capability === capability && probeConfigured(p, env));
  const nonOptIn = configured.filter((p) => !p.optIn);
  const pool = nonOptIn.length > 0 ? nonOptIn : configured;
  return [...pool].sort((a, b) => BACKEND_RANK[a.backend] - BACKEND_RANK[b.backend]);
}
