/**
 * Live registry of NAMED persistent agents (named live agents — the Claude
 * Code SendMessage/agent-teams foundation, effort
 * `.planning/2026-08-22-subagent-teams-parity` ticket 01).
 *
 * Distinct from {@link getSubagentInFlightRegistry} in both lifetime and
 * purpose: the in-flight registry tracks one-shot dispatch runs (entry evicted
 * when the awaited tool call returns); THIS registry holds child SESSIONS that
 * survive their first exchange so the parent can re-prompt them later by
 * `name` or `agentId` (send_message, tickets 02+). Entries leave via explicit
 * dispose, LRU eviction, or session shutdown — never via exchange completion.
 *
 * Process-local by design (children are in-process createAgentSession sessions)
 * and module-singleton for the same reason as the in-flight registry: the
 * subagent extension, the ultracode extension, and peers must share ONE
 * registry across extension instances. Importers must reach this through the
 * package barrel so all consumers resolve the same module instance.
 */

/** Names that can never be a live agent's handle. "main" addresses the parent. */
export const RESERVED_AGENT_NAMES: readonly string[] = ["main"];

/**
 * The structural surface the registry needs from a live agent. Declared here
 * (not imported from persistent-agent.ts) so the registry module has no import
 * edge on the session-assembly layer — LiveAgent (persistent-agent.ts)
 * satisfies it structurally, and tests can register minimal fakes.
 */
export interface LiveAgentHandle {
  /** "running" while an exchange is in flight, "idle" between exchanges. */
  readonly status: "running" | "idle";
  /** Bump the LRU clock (called by the registry on every touchpoint). */
  touch(): void;
  /** Abort any in-flight exchange, dispose the session, free resources. Idempotent. */
  dispose(): void;
}

/** One named live agent. The handle stays opaque to the registry (see {@link LiveAgentHandle}). */
export interface LiveAgentEntry {
  /** Unique handle — the address send_message routes by. Reserved: see RESERVED_AGENT_NAMES. */
  name: string;
  /** Stable id linking durable run records across exchanges (the first exchange's toolCallId). */
  agentId: string;
  /** Owning parent session token (dispose scope; "*" = unknown/dispose-all semantics). */
  sessionId: string;
  /** The persistent agent itself. */
  agent: LiveAgentHandle;
  /** Concrete model spec once resolved (display/telemetry). */
  model?: string;
  /** The working directory the session's coding tools are bound to. */
  cwd: string;
  /** The agentType binding, when the agent was opened from a named definition. */
  agentType?: string;
  /** Why the agent left the registry, when disposed by the runtime (not user-visible). */
  disposedReason?: string;
  readonly openedAt: number;
  lastTouchedAt: number;
}

/**
 * Default cap on concurrent live named agents. Sessions are held in-process
 * (memory + an event subscription each), so the roster is LRU-capped the same
 * way background runs are (`SUBAGENT_MAX_BACKGROUND`, background-run-manager).
 * Override via `SUBAGENT_MAX_LIVE`; `0` disables named agents entirely.
 */
export const DEFAULT_MAX_LIVE = 6;

/** Parse the SUBAGENT_MAX_LIVE env knob (invalid values fall back to the default). */
export function maxLiveFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SUBAGENT_MAX_LIVE;
  if (raw === undefined) return DEFAULT_MAX_LIVE;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_LIVE;
}

/**
 * Process-local registry of named live agents. All mutating methods are
 * synchronous — opening/running exchanges belongs to persistent-agent.ts; this
 * module owns naming, resolution, roster, eviction, and disposal scope.
 */
export class LiveAgentRegistry {
  private agents = new Map<string, LiveAgentEntry>();
  private byAgentId = new Map<string, string>();
  private maxLive: number;

  constructor(maxLive: number = maxLiveFromEnv()) {
    this.maxLive = maxLive;
  }

  /** Whether `name` is taken or reserved. */
  isNameTaken(name: string): boolean {
    return RESERVED_AGENT_NAMES.includes(name) || this.agents.has(name);
  }

  /** The live names, in registration order (for rosters and error hints). */
  names(): string[] {
    return [...this.agents.keys()];
  }

  /** Resolve by name, then by agentId. */
  get(nameOrAgentId: string): LiveAgentEntry | undefined {
    const byName = this.agents.get(nameOrAgentId);
    if (byName) return byName;
    const name = this.byAgentId.get(nameOrAgentId);
    return name ? this.agents.get(name) : undefined;
  }

  /** Whether a slot is available at the cap: room left, or at least one IDLE entry to evict. */
  hasCapacity(): boolean {
    if (this.maxLive === 0) return false;
    return this.agents.size < this.maxLive || [...this.agents.values()].some((e) => e.agent.status === "idle");
  }

  /**
   * Register a live agent. Enforces uniqueness + reserved names, and evicts the
   * least-recently-touched IDLE entry when the cap is full (a RUNNING entry is
   * never evicted — its exchange is awaited by a tool call). Returns the entry,
   * or a string error the caller surfaces (name collision / cap exhausted).
   */
  register(input: {
    name: string;
    agentId: string;
    sessionId?: string;
    agent: LiveAgentHandle;
    model?: string;
    cwd: string;
    agentType?: string;
  }): LiveAgentEntry | { error: string } {
    if (RESERVED_AGENT_NAMES.includes(input.name)) {
      return { error: `"${input.name}" is a reserved name (addresses the parent session).` };
    }
    if (this.agents.has(input.name)) {
      return {
        error: `a live agent named "${input.name}" already exists. Live agents: ${this.names().join(", ") || "(none)"}.`,
      };
    }
    if (this.maxLive === 0) {
      return { error: "named live agents are disabled (SUBAGENT_MAX_LIVE=0)." };
    }
    if (this.agents.size >= this.maxLive) {
      const victim = [...this.agents.values()]
        .filter((e) => e.agent.status === "idle")
        .sort((a, b) => a.lastTouchedAt - b.lastTouchedAt)[0];
      if (!victim) {
        return {
          error: `live-agent cap reached (${this.maxLive}) and every agent is mid-exchange. Live agents: ${this.names().join(", ")}.`,
        };
      }
      this.release(victim.name, "lru-eviction");
    }
    const now = Date.now();
    const entry: LiveAgentEntry = {
      name: input.name,
      agentId: input.agentId,
      sessionId: input.sessionId ?? "*",
      agent: input.agent,
      model: input.model,
      cwd: input.cwd,
      agentType: input.agentType,
      openedAt: now,
      lastTouchedAt: now,
    };
    this.agents.set(input.name, entry);
    this.byAgentId.set(input.agentId, input.name);
    return entry;
  }

  /** Mark the LRU clock for one agent (resolution/lookup is a touchpoint). No-op for unknown names. */
  touch(name: string): void {
    const e = this.agents.get(name);
    if (e) {
      e.lastTouchedAt = Date.now();
      e.agent.touch();
    }
  }

  /**
   * Remove and dispose one agent. The durable run records stay (write-once,
   * linked by agentId); only the live session dies and the name frees up.
   * No-op for an unknown name; idempotent.
   */
  release(name: string, reason = "explicit"): boolean {
    const e = this.agents.get(name);
    if (!e) return false;
    this.agents.delete(name);
    this.byAgentId.delete(e.agentId);
    e.disposedReason = reason;
    try {
      e.agent.dispose();
    } catch {
      // dispose is best-effort — the entry is already gone from the roster.
    }
    return true;
  }

  /**
   * Dispose every agent whose sessionId matches (or ALL agents when the
   * session token is unknown/"*"). The session_shutdown path: a parent session
   * ending takes its named children with it — they are in-process sessions
   * whose parent addressability no longer exists.
   */
  disposeFor(sessionId: string): number {
    let n = 0;
    for (const [name, e] of [...this.agents]) {
      if (e.sessionId === sessionId || sessionId === "*" || e.sessionId === "*") {
        this.release(name, "session-shutdown");
        n++;
      }
    }
    return n;
  }

  /** Drop every entry without disposing (test reset). */
  clear(): void {
    this.agents.clear();
    this.byAgentId.clear();
  }

  get size(): number {
    return this.agents.size;
  }
}

let _liveRegistrySingleton: LiveAgentRegistry | undefined;

/**
 * Process-wide singleton — the subagent extension (spawn/register), the
 * ultracode extension, and future send_message routing all share ONE registry
 * across extension instances, mirroring getSubagentInFlightRegistry().
 */
export function getLiveAgentRegistry(): LiveAgentRegistry {
  // biome-ignore lint/suspicious/noAssignInExpressions: lazy-init singleton idiom
  return (_liveRegistrySingleton ??= new LiveAgentRegistry());
}

/** Test-only: reset the singleton (the shared-module-identity trap the in-flight registry documents). */
export function __resetLiveAgentRegistryForTests(): void {
  _liveRegistrySingleton = undefined;
}
