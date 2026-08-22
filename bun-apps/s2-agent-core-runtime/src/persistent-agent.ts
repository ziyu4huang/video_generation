/**
 * Named persistent agents (effort `.planning/2026-08-22-subagent-teams-parity`,
 * ticket 01 — the Claude Code SendMessage / agent-teams foundation).
 *
 * A LiveAgent wraps ONE pi child session that survives its first exchange:
 * `send()` re-prompts an idle session (ordinary multi-turn `session.prompt`) or
 * steers a mid-flight one (`session.steer`). The budget/turn guards attach ONCE
 * at open and live for the agent's whole lifetime — both read CUMULATIVE
 * session stats (`getSessionStats()` / `turn_end` events), so the ceilings
 * passed at open are enforced AGGREGATE across every exchange, not per prompt.
 * That is the deliberate semantic difference from the one-shot
 * CoreAgent.run path, whose caps bound a single dispatch (ADR-subagent-0008).
 *
 * CoreAgent.run's create/dispose contract is untouched: session assembly is
 * shared through CoreAgent.assembleSession() (extracted verbatim from run()),
 * and this module owns the rest — the lifetime subscription, per-exchange
 * timeouts, guard checks, and disposal.
 */

import type { AgentSession, CreateAgentSessionOptions, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type AssembledSession, CoreAgent, lastAssistantText } from "./agent.js";
import type { BudgetExhaustion } from "./agent-budget.js";
import { type AgentUsage, createBudgetGuard } from "./agent-budget.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import { compactAgentHistory } from "./agent-history.js";
import type { TurnExhaustion } from "./agent-turns.js";
import { createTurnGuard } from "./agent-turns.js";
import { getLiveAgentRegistry, type LiveAgentEntry, type LiveAgentRegistry } from "./live-agent-registry.js";
import {
  classifyError,
  deriveTaskLabel,
  resolveSessionOverride,
  resolveSpawnModelInputs,
  type SpawnSubagentOptions,
  type SpawnSubagentResult,
  type SubagentFailure,
} from "./spawn-subagent.js";

/** Open-time inputs. Model/tool fields mirror SpawnSubagentOptions semantics. */
export interface OpenLiveAgentOptions {
  /** Working directory for the session's coding tools (agent cwd for its lifetime). */
  cwd?: string;
  /** Extra system guidance prepended to every exchange (agent identity). */
  instructions?: string;
  /** Tool allowlist / denylist (agentType bindings). */
  tools?: string[];
  excludeTools?: string[];
  /** Model spec chain — resolved once at open; later exchanges reuse the session's model. */
  model?: string;
  tier?: string;
  capability?: string;
  mainModel?: string;
  scopedModels?: readonly string[];
  /** Parent-session tools bridged into the child (the R2/extensionTools seam). */
  extensionTools?: ToolDefinition[];
  /** Override any createAgentSession option (same merge rule as spawnSubagent). */
  session?: Partial<CreateAgentSessionOptions>;
  modelRuntime?: CreateAgentSessionOptions["modelRuntime"];
  /**
   * AGENT-LIFETIME ceilings: checked against cumulative session stats after
   * every exchange (first crossing of tokenBudget still earns the two-stage
   * wrap-up grace inside the exchange where it fires — see agent-budget.ts).
   */
  tokenBudget?: number;
  spendBudget?: number;
  maxTurns?: number;
  onModelResolved?: (modelId: string) => void;
  onModelFallback?: (requestedSpec: string) => void;
  /** Live history snapshots (throttled to ≥250ms, same as CoreAgent.run). */
  onHistory?: (history: AgentHistoryEntry[]) => void;
  /** Injectable session assembly for tests (defaults to a real CoreAgent). */
  assemble?: (options: {
    agentOptions: ConstructorParameters<typeof CoreAgent>[0];
    assembly: Parameters<CoreAgent["assembleSession"]>[0];
  }) => Promise<AssembledSession>;
}

/** One exchange's outcome. Mirrors SpawnSubagentResult so dispatch-layer consumers need no translation. */
export interface LiveAgentExchange {
  output: string;
  failure?: SubagentFailure;
  usage?: AgentUsage;
  /** Cumulative turns at exchange end (`maxTurns` absent when uncapped). */
  turns?: TurnExhaustion;
  /** True when the text was steered into a mid-flight exchange instead of starting a new one. */
  steered?: boolean;
}

export type LiveAgentStatus = "running" | "idle";

/**
 * A persistent child session addressable by name. NOT thread-safe across
 * concurrent send() calls on the same instance — the registry is the
 * serialization point (one exchange at a time per agent; a send while running
 * degrades to steer() by design).
 */
export class LiveAgent {
  readonly session: AgentSession;
  private readonly unsubscribe?: () => void;
  private readonly instructions?: string;
  private readonly budgetGuard: ReturnType<typeof createBudgetGuard>;
  private readonly turnGuard: ReturnType<typeof createTurnGuard>;
  private readonly onHistory?: (history: AgentHistoryEntry[]) => void;
  /** Previous cumulative stats snapshot — per-exchange usage is the delta. */
  private prevStats: AgentUsage | undefined;
  private _status: LiveAgentStatus = "idle";
  private _disposed = false;
  /** Set when a lifetime ceiling fired — further sends return it without prompting. */
  private terminalFailure: SubagentFailure | undefined;
  private lastHistoryEmit = 0;

  constructor(init: {
    session: AgentSession;
    unsubscribe?: () => void;
    instructions?: string;
    budgetGuard: ReturnType<typeof createBudgetGuard>;
    turnGuard: ReturnType<typeof createTurnGuard>;
    onHistory?: (history: AgentHistoryEntry[]) => void;
  }) {
    this.session = init.session;
    this.unsubscribe = init.unsubscribe;
    this.instructions = init.instructions;
    this.budgetGuard = init.budgetGuard;
    this.turnGuard = init.turnGuard;
    this.onHistory = init.onHistory;
  }

  get status(): LiveAgentStatus {
    return this._status;
  }

  get disposed(): boolean {
    return this._disposed;
  }

  /** The agent-lifetime exhaustion record, once a ceiling has fired. */
  get exhaustion(): SubagentFailure | undefined {
    return this.terminalFailure;
  }

  touch(): void {
    // LRU clock lives on the registry entry; the handle's touch is the hook.
  }

  /** Cumulative session usage (the aggregate the lifetime ceilings read). */
  stats(): AgentUsage | undefined {
    try {
      const { tokens, cost } = this.session.getSessionStats();
      return {
        input: tokens.input,
        output: tokens.output,
        cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite,
        total: tokens.total,
        cost,
      };
    } catch {
      return undefined;
    }
  }

  private emitHistory(): void {
    if (!this.onHistory) return;
    const now = Date.now();
    if (now - this.lastHistoryEmit < 250) return;
    this.lastHistoryEmit = now;
    try {
      this.onHistory(compactAgentHistory(this.session.messages));
    } catch {
      // History is diagnostic only — never let it mask the exchange outcome.
    }
  }

  private buildPrompt(text: string, label?: string): string {
    return [this.instructions, label ? `Task label: ${label}` : undefined, text].filter(Boolean).join("\n\n");
  }

  private usageDelta(): AgentUsage | undefined {
    let current: AgentUsage | undefined;
    try {
      const { tokens, cost } = this.session.getSessionStats();
      current = {
        input: tokens.input,
        output: tokens.output,
        cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite,
        total: tokens.total,
        cost,
      };
    } catch {
      return undefined;
    }
    const prev = this.prevStats;
    this.prevStats = current;
    if (!prev) return current;
    const d = (a: number, b: number) => Math.max(0, a - b);
    return {
      input: d(current.input, prev.input),
      output: d(current.output, prev.output),
      cacheRead: d(current.cacheRead, prev.cacheRead),
      cacheWrite: d(current.cacheWrite, prev.cacheWrite),
      total: d(current.total, prev.total),
      cost: Math.max(0, current.cost - prev.cost),
    };
  }

  /**
   * One exchange. Idle → `session.prompt` under a per-exchange timeout (abort
   * ends the loop; the session stays reusable). Running → `session.steer`
   * (queued after the current turn's tool calls) and immediate return with
   * `steered: true`. A fired lifetime ceiling (budget/turns) or a disposed
   * session returns its failure without prompting.
   */
  async send(
    text: string,
    opts: { timeoutMs?: number; signal?: AbortSignal; label?: string } = {},
  ): Promise<LiveAgentExchange> {
    if (this._disposed) {
      return { output: "", failure: { kind: "failed", message: "live agent disposed" } };
    }
    if (this.terminalFailure) {
      return { output: "", failure: this.terminalFailure };
    }
    if (this.session.isStreaming) {
      await this.session.steer(text);
      return { output: "", steered: true };
    }

    let removeSignalListener: (() => void) | undefined;
    const onAbort = () => void this.session.abort();
    if (opts.signal?.aborted) {
      return { output: "", failure: { kind: "timedout", message: "live agent aborted before exchange" } };
    }
    if (opts.signal) {
      opts.signal.addEventListener("abort", onAbort, { once: true });
      removeSignalListener = () => opts.signal?.removeEventListener("abort", onAbort);
    }
    let timedOut = false;
    const onTimeout = () => {
      timedOut = true;
      onAbort();
    };
    const timer = opts.timeoutMs ? setTimeout(onTimeout, opts.timeoutMs) : undefined;

    this._status = "running";
    try {
      await this.session.prompt(this.buildPrompt(text, opts.label));
      // Lifetime ceilings — checked in the same order run() checks its per-run
      // guards (budget before turns), then re-recorded as the agent's terminal
      // failure so later sends refuse instead of re-prompting a capped session.
      if (this.budgetGuard.exhaustion) {
        const ex: BudgetExhaustion = this.budgetGuard.exhaustion;
        this.terminalFailure = {
          kind: "budget",
          message: `live agent lifetime token/spend budget exhausted (${ex.kind === "tokens" ? `${ex.actual} tokens` : `$${ex.actual.toFixed(4)}`} > limit ${ex.limit})`,
          budget: ex,
        };
        return { output: "", failure: this.terminalFailure, usage: this.usageDelta() };
      }
      if (this.turnGuard.exhaustion) {
        const tx: TurnExhaustion = this.turnGuard.exhaustion;
        this.terminalFailure = {
          kind: "turns",
          message: `live agent lifetime turn cap reached (${tx.turnsUsed} > ${tx.maxTurns})`,
          turns: tx,
        };
        return { output: "", failure: this.terminalFailure, usage: this.usageDelta(), turns: tx };
      }
      if (opts.signal?.aborted || timedOut) {
        return {
          output: "",
          failure: { kind: "timedout", message: "live agent exchange aborted (timeout)" },
          usage: this.usageDelta(),
        };
      }
      const output = lastAssistantText(this.session.messages);
      return {
        output,
        usage: this.usageDelta(),
        turns: { turnsUsed: this.turnGuard.turnsUsed },
      };
    } catch (e) {
      const classified = classifyError(e, opts.signal?.aborted === true);
      return { output: "", failure: classified.failure, usage: this.usageDelta() };
    } finally {
      if (timer) clearTimeout(timer);
      removeSignalListener?.();
      this._status = "idle";
      this.emitHistory();
    }
  }

  /** Abort any in-flight exchange, tear down the subscription, dispose the session. Idempotent. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    try {
      if (this.session.isStreaming) void this.session.abort();
    } catch {
      // best-effort — dispose() below is the real teardown
    }
    this.unsubscribe?.();
    try {
      this.session.dispose();
    } catch {
      // already torn down (e.g. session_shutdown raced us)
    }
  }
}

/**
 * Assemble + open a named persistent agent: builds a CoreAgent (same option
 * surface spawnSubagent uses), assembles the session through the shared
 * CoreAgent.assembleSession, attaches the LIFETIME guards and one subscription,
 * and returns the LiveAgent. Registration into the live registry belongs to
 * spawnLiveAgentFirstExchange / the caller.
 */
export async function openLiveAgent(options: OpenLiveAgentOptions): Promise<LiveAgent> {
  const agentOptions: ConstructorParameters<typeof CoreAgent>[0] = {
    cwd: options.cwd,
    extensionTools: options.extensionTools,
    mainModel: options.mainModel,
    scopedModels: options.scopedModels,
    session: resolveSessionOverride(options.session, options.modelRuntime),
  };
  // Same model-input precedence as spawnSubagent (model > capability > tier >
  // mainModel) — the capability leg resolves here, the rest inside assembleSession.
  const { effectiveModel } = resolveSpawnModelInputs({
    model: options.model,
    capability: options.capability,
    tier: options.tier,
    mainModel: options.mainModel,
  } as SpawnSubagentOptions);

  const assemble =
    options.assemble ??
    (async (input: Parameters<NonNullable<OpenLiveAgentOptions["assemble"]>>[0]) => {
      const agent = new CoreAgent(input.agentOptions);
      return agent.assembleSession(input.assembly);
    });

  const { session } = await assemble({
    agentOptions,
    assembly: {
      cwd: options.cwd,
      toolNames: options.tools,
      disallowedToolNames: options.excludeTools,
      model: effectiveModel,
      tier: options.tier,
      onModelResolved: options.onModelResolved,
      onModelFallback: options.onModelFallback,
      // Named live agents do not support structured output (v1): the schema
      // tool is a per-run capture contract that has no meaning on a session
      // that keeps talking. The tool layer rejects name+schema earlier.
    },
  });

  // Lifetime guards — attached ONCE, subscribed for the agent's whole life.
  // Both read cumulative session state, so these ceilings hold across every
  // exchange (aggregate enforcement; see the module header).
  const budgetGuard = createBudgetGuard(session, {
    tokenBudget: options.tokenBudget,
    spendBudget: options.spendBudget,
  });
  const turnGuard = createTurnGuard(session, { maxTurns: options.maxTurns });
  const unsubscribe = session.subscribe((event) => {
    budgetGuard.onSessionEvent(event);
    turnGuard.onSessionEvent(event);
  });

  return new LiveAgent({
    session,
    unsubscribe,
    instructions: options.instructions,
    budgetGuard,
    turnGuard,
    onHistory: options.onHistory,
  });
}

/**
 * Run a named agent's FIRST exchange through the full spawn-options surface
 * (the same shape dispatchChild hands spawnSubagent) and, when the session is
 * still usable afterwards, register it as a live agent. Single attempt — no
 * retryOnTransient (a retry needs a fresh session; a named agent's value IS
 * its persistent one). A budget/turns-exhausted first exchange disposes the
 * agent and registers nothing: there is nothing left to talk to.
 *
 * Returns the exchange result (SpawnSubagentResult-shaped) plus the live
 * agent + registry entry when registered.
 */
export async function spawnLiveAgentFirstExchange(
  opts: SpawnSubagentOptions,
  open: {
    name: string;
    agentId: string;
    sessionId?: string;
    agentType?: string;
    registry?: LiveAgentRegistry;
    /** Injectable opener for tests (defaults to the real openLiveAgent). */
    openAgent?: typeof openLiveAgent;
  },
): Promise<{ result: SpawnSubagentResult; agent?: LiveAgent; entry?: LiveAgentEntry }> {
  const registry = open.registry ?? getLiveAgentRegistry();
  // Fail fast BEFORE creating a session: reserved name, collision, or no cap slot.
  if (registry.isNameTaken(open.name)) {
    return {
      result: {
        output: "",
        failure: {
          kind: "failed",
          message: registry.names().includes(open.name)
            ? `a live agent named "${open.name}" already exists. Live agents: ${registry.names().join(", ") || "(none)"}.`
            : `"${open.name}" is a reserved name (addresses the parent session).`,
        },
      },
    };
  }
  if (!registry.hasCapacity()) {
    return {
      result: {
        output: "",
        failure: {
          kind: "failed",
          message: `live-agent cap reached and every agent is mid-exchange. Live agents: ${registry.names().join(", ") || "(none)"}.`,
        },
      },
    };
  }

  const openAgent = open.openAgent ?? openLiveAgent;
  const agent = await openAgent({
    cwd: opts.cwd,
    instructions: opts.instructions,
    tools: opts.tools,
    excludeTools: opts.excludeTools,
    model: opts.model,
    tier: opts.tier,
    capability: opts.capability,
    mainModel: opts.mainModel,
    scopedModels: opts.scopedModels,
    extensionTools: opts.extensionTools,
    session: opts.session,
    modelRuntime: opts.modelRuntime,
    tokenBudget: opts.tokenBudget,
    spendBudget: opts.spendBudget,
    maxTurns: opts.maxTurns,
    onModelResolved: opts.onModelResolved,
    onModelFallback: opts.onModelFallback,
    onHistory: opts.onHistory,
  });

  const exchange = await agent.send(opts.task, {
    timeoutMs: opts.timeoutMs,
    signal: opts.externalSignal,
    label: opts.label ?? deriveTaskLabel(opts.task),
  });
  const result: SpawnSubagentResult = {
    output: exchange.output,
    failure: exchange.failure,
    usage: exchange.usage,
    ...(exchange.turns ? { turns: exchange.turns } : {}),
  };

  // A lifetime ceiling fired on the first exchange — the session is capped
  // forever; dispose and register nothing.
  if (exchange.failure?.kind === "budget" || exchange.failure?.kind === "turns") {
    agent.dispose();
    return { result };
  }

  const registered = registry.register({
    name: open.name,
    agentId: open.agentId,
    sessionId: open.sessionId,
    agent,
    model: opts.model,
    cwd: opts.cwd ?? process.cwd(),
    agentType: open.agentType,
  });
  if ("error" in registered) {
    // Lost a registration race (same name registered between the pre-check and
    // now) — dispose our session and surface the collision.
    agent.dispose();
    return {
      result: {
        output: exchange.output,
        failure: { kind: "failed", message: registered.error },
        usage: exchange.usage,
      },
    };
  }
  return { result, agent, entry: registered };
}
