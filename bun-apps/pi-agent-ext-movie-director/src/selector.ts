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
  if (configured.length === 0) throw new NoConfiguredProviderError(capability);

  if (opts.provider) {
    const hit = configured.find((p) => p.provider === opts.provider);
    if (hit) return hit;
    // Soft hint: a non-matching provider name is ignored, not fatal.
  }

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
  // (we threw above), but noUncheckedIndexedAccess makes [0] possibly-undefined;
  // the fallback is unreachable and exists only to satisfy the type.
  return [...configured].sort((a, b) => BACKEND_RANK[a.backend] - BACKEND_RANK[b.backend])[0]!;
}

/** All callable providers for a capability, ranked best-first (for menu/UI). */
export function rankedProviders(capability: Capability, env: Record<string, string | undefined> = process.env): ProviderEntry[] {
  return REGISTRY.filter((p) => p.capability === capability && probeConfigured(p, env)).sort(
    (a, b) => BACKEND_RANK[a.backend] - BACKEND_RANK[b.backend],
  );
}
