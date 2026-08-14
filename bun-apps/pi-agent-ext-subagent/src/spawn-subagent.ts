/**
 * `spawnSubagent()` — a thin shared wrapper over `WorkflowAgent.run` (in-process
 * `createAgentSession`) exposed for non-workflow callers (sub-project ①:
 * knowledge-card's `zk_card` / `zk_ask` migrate here off pi-obsidian's child-
 * process `runSubagentWithRetry`).
 *
 * The return shape MIRRORS `runSubagentWithRetry` (`{output, exitCode, stderr,
 * timedOut}`) so callers change one line and their result-handling stays
 * byte-identical. `WorkflowAgent.run` returns a string or throws, so this helper
 * ADAPTS success/throw into that shape, classifies transient failures (timeout /
 * abort / network) for the single retry, and accepts an injectable `agent` runner
 * for unit testing without a real session.
 *
 * `prime?` is a no-op forward-reference to sub-project ③ (auto-primer). `extensionTools?`
 * is the R2 bridge (Phase-1 finding): parent-session tools threaded into the child so
 * obsidian tools reach it in BOTH manifest-installed and `-e` dev mode.
 */

import type { CreateAgentSessionOptions, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentHistoryEntry } from "@repo/pi-agent-ext-core-runtime";
import {
  type AgentUsage,
  type BudgetExhaustion,
  isWorkflowError,
  loadModelTierConfig,
  resolveModelRole,
  WorkflowAgent,
  WorkflowErrorCode,
} from "@repo/pi-agent-ext-core-runtime";
import type { TSchema } from "typebox";

export interface SpawnSubagentPrime {
  query: string;
  topK?: number;
  folder?: string;
}

export interface SpawnSubagentOptions {
  task: string;
  /** Curated tool allowlist (obsidian tool names for zk_*). */
  tools?: string[];
  /** Tool names to deny after the allowlist. */
  excludeTools?: string[];
  model?: string;
  /** Model tier name (e.g. "small"/"medium"/"big"), resolved from model-tiers config. */
  tier?: string;
  /**
   * Model capability for the child (e.g. "vision"), resolved from the
   * capabilities map in model-tiers config. Precedence: model > capability >
   * tier > mainModel. An unconfigured capability warns and falls back.
   */
  capability?: string;
  /**
   * Override any createAgentSession option (modelRuntime, authStorage,
   * resourceLoader, …) — threaded to the WorkflowAgent constructor's `session`
   * override, which is spread into createAgentSession. Lets a caller (e.g.
   * file2md) inject a custom local ModelRuntime for a vision model.
   */
  session?: Partial<CreateAgentSessionOptions>;
  /**
   * The parent session's authenticated ModelRuntime — when set, the child
   * reuses it (auth/context sharing) instead of building its own from agentDir
   * (createAgentSession's `modelRuntime ?? ModelRuntime.create(...)` skips the
   * disk read). Shortcut for `session: { modelRuntime }`; the top-level opt
   * wins on conflict (it is the more-specific, explicit choice). The runtime
   * was itself config-resolved by the parent, so this is NOT a hardcode.
   * Used by core-task's auditor to share the parent's auth (ticket 07/08).
   */
  modelRuntime?: CreateAgentSessionOptions["modelRuntime"];
  /** Image attachments for a vision-capable subagent (see AgentRunOptions.images). */
  images?: unknown[];
  schema?: TSchema;
  /**
   * Max in-session repair re-prompts when the child returns prose instead of
   * calling structured_output (default 2). Each repair restricts tools to
   * structured_output and re-nudges; a schema-valid JSON block in prose is also
   * accepted as a last resort. Bump for models that unreliably emit structured
   * output (e.g. zai/glm).
   */
  schemaRepairAttempts?: number;
  instructions?: string;
  cwd?: string;
  timeoutMs?: number;
  /** Abort the child mid-run once cumulative tokens exceed this (per-run cap). */
  tokenBudget?: number;
  /** Abort the child mid-run once cumulative cost ($) exceeds this (per-run cap). */
  spendBudget?: number;
  /** Retry once on a transient (timeout/abort/network/schema-noncompliance) failure. Default true. */
  retryOnTransient?: boolean;
  /** Forward-ref to ③ — accepted but does NOT retrieve or alter output. */
  prime?: SpawnSubagentPrime;
  /** Parent-session tools to bridge into the child (R2). */
  extensionTools?: ToolDefinition[];
  /**
   * The parent session's current model (provider/id). When neither `model` nor
   * `tier` is set, the child defaults to this (the live session model) rather
   * than a possibly-stale medium tier. Also threaded into WorkflowAgent so an
   * unknown-tier warning can name the fallback model.
   */
  mainModel?: string;
  /** Fires with the concrete `provider/id` the child actually runs on, once known. */
  onModelResolved?: (modelId: string) => void;
  /** Fires when a requested model/tier spec couldn't be resolved (fell back). */
  onModelFallback?: (requestedSpec: string) => void;
  /** Injectable runner (tests pass a mock; production omits → new WorkflowAgent). */
  agent?: Pick<WorkflowAgent, "run">;
  /** Host signal (e.g. tool-call Ctrl+C) that should cancel this call when fired. */
  externalSignal?: AbortSignal;
  /**
   * Compact live snapshot of the child's message/tool history, forwarded
   * verbatim from `WorkflowAgent.run()`'s own `onHistory` (already throttled
   * to ≥250ms there — no additional throttling needed here).
   */
  onHistory?: (history: AgentHistoryEntry[]) => void;
  /**
   * Fires with the child's real token/cost usage once known. Emitted exactly
   * once, at run completion (the runner reads session stats in its `finally`).
   * Mirrors {@link onHistory} / {@link onModelResolved} / {@link onModelFallback}
   * — additive + optional. The internal `result.usage` capture is unchanged, so
   * both this live callback and the final result carry usage.
   */
  onUsage?: (u: AgentUsage) => void;
}

export interface SpawnSubagentResult {
  output: string;
  exitCode: number;
  stderr: string;
  timedOut: boolean;
  /** Real token/cost usage read from the child session, when the runner reports it. */
  usage?: AgentUsage;
  /** Set when the run was aborted for exceeding tokenBudget/spendBudget (distinct from timedOut/failed). */
  budget?: BudgetExhaustion;
}

const TRANSIENT_NETWORK_RE =
  /econnreset|econnrefused|enotfound|socket hang up|rate.?limit|429|503|502|network|fetch failed|eai_again/i;

interface ErrorClass {
  transient: boolean;
  timedOut: boolean;
  message: string;
  budget?: BudgetExhaustion;
}

function classifyError(e: unknown, signalAborted = false): ErrorClass {
  const message = e instanceof Error ? e.message : String(e);
  // Budget exhaustion is non-recoverable: retrying would re-exhaust the same
  // ceiling. Surfaced distinctly (result.budget) so the caller can tell a
  // capped run apart from a generic failure or a timeout.
  if (isWorkflowError(e) && e.code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED) {
    return { transient: false, timedOut: false, message, budget: e.details as BudgetExhaustion | undefined };
  }
  // Schema noncompliance is intermittent on some models (zai/glm unreliably
  // emits structured_output under load) — a fresh full re-run usually succeeds,
  // so treat it as transient (the inner in-session repair already re-nudged
  // twice). Retried only when retryOnTransient is on (default true).
  if (isWorkflowError(e) && e.code === WorkflowErrorCode.SCHEMA_NONCOMPLIANCE) {
    return { transient: true, timedOut: false, message };
  }
  if (isWorkflowError(e) && e.code === WorkflowErrorCode.AGENT_TIMEOUT) {
    return { transient: true, timedOut: true, message };
  }
  // Our own timeoutMs gate fires by aborting the call's controller — checking
  // the signal directly is authoritative, because the real WorkflowAgent runner
  // surfaces that abort as a plain `Error("Subagent was aborted")` (name
  // "Error"), NOT a DOMException named AbortError.
  if (signalAborted) {
    return { transient: true, timedOut: true, message };
  }
  // Fallback for runner-shaped abort errors: match name OR message.
  if (e instanceof Error && (/\babort/i.test(e.name) || /\baborted?\b/i.test(message))) {
    return { transient: true, timedOut: true, message };
  }
  if (TRANSIENT_NETWORK_RE.test(message)) {
    return { transient: true, timedOut: false, message };
  }
  return { transient: false, timedOut: false, message };
}

/** Sum token/cost usage across retry attempts (undefined-safe). */
function mergeUsage(a: AgentUsage | undefined, b: AgentUsage | undefined): AgentUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
    cost: a.cost + b.cost,
  };
}

/** Merge a caller-provided `modelRuntime` into the session override. The runtime
 *  wins over any `session.modelRuntime` (explicit top-level opt is more
 *  specific). Pure + exported so the merge contract is unit-testable without
 *  constructing a real WorkflowAgent (mock.module would leak under bun's
 *  shared-realm default). */
export function resolveSessionOverride(
  session: Partial<CreateAgentSessionOptions> | undefined,
  modelRuntime: CreateAgentSessionOptions["modelRuntime"] | undefined,
): Partial<CreateAgentSessionOptions> | undefined {
  return modelRuntime ? { ...session, modelRuntime } : session;
}

export async function spawnSubagent(opts: SpawnSubagentOptions): Promise<SpawnSubagentResult> {
  const runner =
    opts.agent ??
    new WorkflowAgent({
      cwd: opts.cwd,
      extensionTools: opts.extensionTools,
      mainModel: opts.mainModel,
      session: resolveSessionOverride(opts.session, opts.modelRuntime),
    });
  const retry = opts.retryOnTransient !== false;
  // Default-to-current-LLM: when the caller neither picks a model nor a tier, fall
  // back to the live session model (not a stale medium tier). Explicit model or
  // tier always wins; resolveAgentModelSpec in agent.ts handles the rest.
  // Resolve a capability (e.g. "vision") to a model-spec. Precedence:
  // explicit model > capability > tier > mainModel. An unconfigured capability
  // warns and falls through to tier/mainModel (mirrors agent.ts unknown-tier).
  let capabilitySpec: string | undefined;
  if (opts.capability) {
    const cfg = loadModelTierConfig();
    capabilitySpec = resolveModelRole({ capability: opts.capability }, cfg);
    if (!capabilitySpec) {
      const known = cfg?.capabilities ? Object.keys(cfg.capabilities).join(", ") || "(none)" : "(none)";
      console.error(
        `[subagent] unknown capability "${opts.capability}" — falling back. Configured capabilities: ${known}. Add a capabilities map to ~/.pi/workflows/model-tiers.json.`,
      );
    }
  }
  const effectiveModel = opts.model ?? capabilitySpec ?? (opts.tier ? undefined : opts.mainModel);

  const tryOnce = async (): Promise<{ result: SpawnSubagentResult; transient: boolean }> => {
    const ac = new AbortController();
    if (opts.externalSignal) {
      if (opts.externalSignal.aborted) ac.abort();
      else opts.externalSignal.addEventListener("abort", () => ac.abort(), { once: true });
    }
    const timer = opts.timeoutMs ? setTimeout(() => ac.abort(), opts.timeoutMs) : undefined;
    let usage: AgentUsage | undefined;
    try {
      // `prime` is intentionally NOT used here (③ owns the auto-primer).
      const out = await runner.run(opts.task, {
        label: "zk-spawn",
        schema: opts.schema,
        instructions: opts.instructions,
        model: effectiveModel,
        tier: opts.tier,
        images: opts.images,
        toolNames: opts.tools,
        disallowedToolNames: opts.excludeTools,
        cwd: opts.cwd,
        signal: ac.signal,
        onModelResolved: opts.onModelResolved,
        onModelFallback: opts.onModelFallback,
        onUsage: (u) => {
          usage = u;
          opts.onUsage?.(u);
        },
        onHistory: opts.onHistory,
        tokenBudget: opts.tokenBudget,
        spendBudget: opts.spendBudget,
        maxSchemaRetries: opts.schemaRepairAttempts,
      } as Parameters<WorkflowAgent["run"]>[1]);
      // When `opts.schema` is set, `run()` returns a validated OBJECT (not a
      // string). `String(obj)` would yield "[object Object]" and silently
      // destroy the schema payload — JSON-serialize it instead so callers
      // that parse `output` keep working. Null/undefined → empty string.
      const output = typeof out === "string" ? out : out == null ? "" : JSON.stringify(out);
      return { result: { output, exitCode: 0, stderr: "", timedOut: false, usage }, transient: false };
    } catch (e) {
      const c = classifyError(e, ac.signal.aborted);
      return {
        result: {
          output: "",
          exitCode: c.timedOut ? 124 : 1,
          stderr: c.message,
          timedOut: c.timedOut,
          usage,
          ...(c.budget ? { budget: c.budget } : {}),
        },
        transient: c.transient,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const first = await tryOnce();
  if (first.result.exitCode === 0 || !retry || !first.transient) return first.result;
  // Never retry a cancel the caller (or user) explicitly requested — retrying
  // would re-run work that was just aborted.
  if (opts.externalSignal?.aborted) return first.result;
  // Single retry on a transient failure (mirrors runSubagentWithRetry). The
  // failed first attempt still burned real tokens (largest exactly when it
  // timed out) — surface the SUM of both attempts, not just the second.
  const second = await tryOnce();
  return { ...second.result, usage: mergeUsage(first.result.usage, second.result.usage) };
}
