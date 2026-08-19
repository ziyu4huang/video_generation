/**
 * `spawnSubagent()` — a thin shared wrapper over `WorkflowAgent.run` (in-process
 * `createAgentSession`) exposed for non-workflow callers (sub-project ①:
 * knowledge-card's `zk_card` / `zk_ask` migrate here off pi-obsidian's child-
 * process `runSubagentWithRetry`).
 *
 * The return shape was originally a copy of `runSubagentWithRetry`'s
 * (`{output, exitCode, stderr, timedOut}`) so callers could migrate by changing
 * one line. That subprocess vocabulary described a runner this one is not: there
 * is no process, no exit code and no standard error stream behind
 * `createAgentSession`. It is now `{output, failure?}` — see
 * {@link SubagentFailure}. `WorkflowAgent.run` returns a string or throws, so
 * this helper ADAPTS success/throw into that shape, classifies transient
 * failures (timeout / abort / network) for the single retry, and accepts an
 * injectable `agent` runner for unit testing without a real session.
 *
 * `extensionTools?` is the R2 bridge (Phase-1 finding): parent-session tools threaded
 * into the child so obsidian tools reach it in BOTH manifest-installed and `-e` dev mode.
 */

import type { CreateAgentSessionOptions, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { CoreAgent as WorkflowAgent } from "./agent.js";
import { type AgentUsage, type BudgetExhaustion, type BudgetWarning, checkBudgetWarning } from "./agent-budget.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { TurnExhaustion } from "./agent-turns.js";
import { logModelDecision } from "./debug-models.js";
import { isWorkflowError, WorkflowErrorCode } from "./errors.js";
import { resolveModelRole } from "./model-role-config.js";
import { loadModelTierConfig } from "./model-tier-config.js";

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
   * Used by ext-task's auditor to share the parent's auth (ticket 07/08).
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
  /** Cap the child at this many turns (integer ≥ 1, per-run cap). No default — omit = unlimited turns. */
  maxTurns?: number;
  /** Retry once on a transient (timeout/abort/network/schema-noncompliance) failure. Default true. */
  retryOnTransient?: boolean;
  /** Parent-session tools to bridge into the child (R2). */
  extensionTools?: ToolDefinition[];
  /**
   * The parent session's current model (provider/id). When neither `model` nor
   * `tier` is set, the child defaults to this (the live session model) rather
   * than a possibly-stale medium tier. Also threaded into WorkflowAgent so an
   * unknown-tier warning can name the fallback model.
   */
  mainModel?: string;
  /**
   * The parent session's model scope (`provider/id` specs from `--models` /
   * `enabledModels`). Empty/undefined = full catalog. Threaded into
   * WorkflowAgent, which clamps the child's resolved model into scope AFTER
   * the explicit > capability > tier > mainModel precedence has run — so no
   * single branch of that chain can route outside the scope.
   */
  scopedModels?: readonly string[];
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
   * Label for the child run — surfaces as the runner's agentLabel in child
   * status displays and abort/error messages. Defaults to
   * {@link deriveTaskLabel}(task); pass an explicit label to pin it.
   */
  label?: string;
  /**
   * Fires with the child's real token/cost usage once known. Emitted exactly
   * once, at run completion (the runner reads session stats in its `finally`).
   * Mirrors {@link onHistory} / {@link onModelResolved} / {@link onModelFallback}
   * — additive + optional. The internal `result.usage` capture is unchanged, so
   * both this live callback and the final result carry usage.
   */
  onUsage?: (u: AgentUsage) => void;
}

/**
 * Why the run did not succeed. Absent from a result = the run succeeded.
 *
 * Every variant carries `message`, so a caller that only wants to report "what
 * went wrong" never has to switch on `kind`. The two detail-bearing variants
 * require their detail object: a WorkflowError may arrive with no `details`, and
 * its PRESENCE is what selects the kind (a TURNS_EXHAUSTED with no details is a
 * plain `failed`). `kind` is exactly the run's status, so no caller-side
 * correlation of separate flags is needed to derive one.
 *
 * `aborted` is deliberately absent: a user abort is knowledge the parent turn
 * holds, not the spawn, and is derived in child-dispatch.ts.
 */
export type SubagentFailure =
  | { kind: "failed"; message: string }
  | { kind: "timedout"; message: string }
  | { kind: "turns"; message: string; turns: TurnExhaustion }
  | { kind: "budget"; message: string; budget: BudgetExhaustion };

export interface SpawnSubagentResult {
  output: string;
  /** Absent = success. See {@link SubagentFailure}. */
  failure?: SubagentFailure;
  /** Real token/cost usage read from the child session, when the runner reports it. */
  usage?: AgentUsage;
  /**
   * Informational 80%-of-budget warning (fixed 0.8 ratio): set when the run
   * COMPLETED (not aborted) and final usage reached ≥80% of a set budget —
   * same {kind, limit, actual} shape as the `budget` failure variant's detail.
   * Advisory only: it never aborts, never retries, and never sets `failure`.
   */
  budgetWarning?: BudgetWarning;
  /**
   * Authoritative loop-turn count for a COMPLETED run, captured from the
   * runner's onTurns (TurnGuard turn_end count) per attempt — set on the
   * success path so done runs persist the real count instead of leaving it
   * to the runs-stats assistant-message projection. `maxTurns` key is absent
   * for unlimited runs. Abort paths do NOT set it here: the `turns` failure
   * kind carries its own exhaustion detail.
   */
  turns?: TurnExhaustion;
}

const TRANSIENT_NETWORK_RE =
  /econnreset|econnrefused|enotfound|socket hang up|rate.?limit|429|503|502|network|fetch failed|eai_again/i;

interface ErrorClass {
  /** Whether a single retry is worth attempting (see `retryOnTransient`). */
  transient: boolean;
  failure: SubagentFailure;
}

/**
 * The single home of the outcome taxonomy. The branch ORDER below is the whole
 * precedence rule (budget > timeout > turns > failed) — it used to be mirrored
 * by a second precedence chain in `deriveSubagentStatus`, which is why that
 * helper no longer exists. `tests/failure-union.test.ts` pins one case per
 * branch, including the two detail-less ones.
 */
function classifyError(e: unknown, signalAborted = false): ErrorClass {
  const message = e instanceof Error ? e.message : String(e);
  // Budget exhaustion is non-recoverable: retrying would re-exhaust the same
  // ceiling. Surfaced as its own kind so the caller can tell a capped run apart
  // from a generic failure or a timeout. A budget error that arrived WITHOUT
  // its detail object has nothing to report as a cap, so it degrades to
  // `failed` — the detail's presence is what earns the kind.
  if (isWorkflowError(e) && e.code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED) {
    const budget = e.details as BudgetExhaustion | undefined;
    return { transient: false, failure: budget ? { kind: "budget", message, budget } : { kind: "failed", message } };
  }
  // Schema noncompliance is intermittent on some models (zai/glm unreliably
  // emits structured_output under load) — a fresh full re-run usually succeeds,
  // so treat it as transient (the inner in-session repair already re-nudged
  // twice). Retried only when retryOnTransient is on (default true).
  if (isWorkflowError(e) && e.code === WorkflowErrorCode.SCHEMA_NONCOMPLIANCE) {
    return { transient: true, failure: { kind: "failed", message } };
  }
  if (isWorkflowError(e) && e.code === WorkflowErrorCode.AGENT_TIMEOUT) {
    return { transient: true, failure: { kind: "timedout", message } };
  }
  // Turns exhaustion shares TIMEOUT's RETRY semantics (transient → retried once
  // under retryOnTransient), NOT the budget path's (a retry would re-exhaust the
  // same ceiling). It stays a distinct kind so a turn cap never renders as a
  // wall-clock timeout. Detail-less → `failed`, as with budget above.
  if (isWorkflowError(e) && e.code === WorkflowErrorCode.TURNS_EXHAUSTED) {
    const turns = e.details as TurnExhaustion | undefined;
    return { transient: true, failure: turns ? { kind: "turns", message, turns } : { kind: "failed", message } };
  }
  // Our own timeoutMs gate fires by aborting the call's controller — checking
  // the signal directly is authoritative, because the real WorkflowAgent runner
  // surfaces that abort as a plain `Error("Subagent was aborted")` (name
  // "Error"), NOT a DOMException named AbortError.
  if (signalAborted) {
    return { transient: true, failure: { kind: "timedout", message } };
  }
  // Fallback for runner-shaped abort errors: match name OR message.
  if (e instanceof Error && (/\babort/i.test(e.name) || /\baborted?\b/i.test(message))) {
    return { transient: true, failure: { kind: "timedout", message } };
  }
  if (TRANSIENT_NETWORK_RE.test(message)) {
    return { transient: true, failure: { kind: "failed", message } };
  }
  return { transient: false, failure: { kind: "failed", message } };
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

/** Informational 80% budget warning (never aborts): computed from the FINAL
 *  usage the runner reported (the existing onUsage channel) against whichever
 *  budgets are set. Only meaningful on a completed run. */
function budgetWarningFor(
  usage: AgentUsage | undefined,
  budget: { tokenBudget?: number; spendBudget?: number },
): BudgetWarning | undefined {
  if (!usage) return undefined;
  return checkBudgetWarning(
    { tokens: { total: usage.total }, cost: usage.cost },
    { tokenBudget: budget.tokenBudget, spendBudget: budget.spendBudget },
  );
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

/**
 * Derive a short run label from a task prompt: the leading sentence of the
 * first non-empty line, slugified, capped at 40 chars. Whitespace-only /
 * slug-less input falls back to "task". Replaces the old hardcoded "zk-spawn"
 * label that leaked into every child's status and error messages (2026-08-15
 * incident).
 */
export function deriveTaskLabel(task: string): string {
  const firstLine = task
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const lead = firstLine?.split(/(?<=[.!?])\s/)[0] ?? "";
  const slug = lead
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "task";
}

export async function spawnSubagent(opts: SpawnSubagentOptions): Promise<SpawnSubagentResult> {
  const runner =
    opts.agent ??
    new WorkflowAgent({
      cwd: opts.cwd,
      extensionTools: opts.extensionTools,
      mainModel: opts.mainModel,
      scopedModels: opts.scopedModels,
      session: resolveSessionOverride(opts.session, opts.modelRuntime),
    });
  const retry = opts.retryOnTransient !== false;
  // Default-to-current-LLM: when the caller neither picks a model nor a tier, fall
  // back to the live session model (not a stale medium tier). Explicit model or
  // tier always wins; resolveAgentModelSpec in agent-model.ts handles the rest.
  // Resolve a capability (e.g. "vision") to a model-spec. Precedence:
  // explicit model > capability > tier > mainModel. An unconfigured capability
  // warns and falls through to tier/mainModel (mirrors agent-model.ts unknown-tier).
  let capabilitySpec: string | undefined;
  if (opts.capability) {
    const cfg = loadModelTierConfig();
    capabilitySpec = resolveModelRole({ capability: opts.capability }, cfg);
    logModelDecision("capability", {
      capability: opts.capability,
      spec: capabilitySpec,
      configured: cfg?.capabilities ? Object.keys(cfg.capabilities).join(",") : "(none)",
      fallback: capabilitySpec ? undefined : "tier/mainModel",
    });
    if (!capabilitySpec) {
      const known = cfg?.capabilities ? Object.keys(cfg.capabilities).join(", ") || "(none)" : "(none)";
      console.error(
        `[subagent] unknown capability "${opts.capability}" — falling back. Configured capabilities: ${known}. Add a capabilities map to ~/.pi/workflows/model-tiers.json.`,
      );
    }
  }
  const effectiveModel = opts.model ?? capabilitySpec ?? (opts.tier ? undefined : opts.mainModel);

  // Last-turn wrap-up nudge kill-switch: same escape-hatch shape as
  // SUBAGENT_TOKEN_BUDGET_DISABLE (read at call time, "1"/"true"
  // case-insensitive, budget-defaults.ts envFlagTrue). Unset forwards nothing —
  // the core default (nudge on for capped runs) applies.
  const turnsNudgeDisabled = (() => {
    const raw = process.env.SUBAGENT_TURNS_NUDGE_DISABLE;
    return raw === "1" || raw?.toLowerCase() === "true";
  })();

  const tryOnce = async (): Promise<{ result: SpawnSubagentResult; transient: boolean }> => {
    const ac = new AbortController();
    if (opts.externalSignal) {
      if (opts.externalSignal.aborted) ac.abort();
      else opts.externalSignal.addEventListener("abort", () => ac.abort(), { once: true });
    }
    const timer = opts.timeoutMs ? setTimeout(() => ac.abort(), opts.timeoutMs) : undefined;
    let usage: AgentUsage | undefined;
    // Per-attempt turn count: the producing attempt's own count, so the retry
    // merge (spread of the second attempt's result) keeps it — never a sum.
    let turns: TurnExhaustion | undefined;
    try {
      const out = await runner.run(opts.task, {
        label: opts.label ?? deriveTaskLabel(opts.task),
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
        onTurns: (t) => {
          turns = t as TurnExhaustion;
        },
        onHistory: opts.onHistory,
        tokenBudget: opts.tokenBudget,
        spendBudget: opts.spendBudget,
        maxTurns: opts.maxTurns,
        ...(turnsNudgeDisabled ? { wrapUpNudge: false } : {}),
        maxSchemaRetries: opts.schemaRepairAttempts,
      } as Parameters<WorkflowAgent["run"]>[1]);
      // When `opts.schema` is set, `run()` returns a validated OBJECT (not a
      // string). `String(obj)` would yield "[object Object]" and silently
      // destroy the schema payload — JSON-serialize it instead so callers
      // that parse `output` keep working. Null/undefined → empty string.
      const output = typeof out === "string" ? out : out == null ? "" : JSON.stringify(out);
      // Informational 80% warning on the COMPLETED run (never aborts/retries):
      // computed from this attempt's final usage via the same pure check the
      // abort guard uses, but purely advisory.
      const budgetWarning = budgetWarningFor(usage, opts);
      return {
        result: { output, usage, ...(budgetWarning ? { budgetWarning } : {}), ...(turns ? { turns } : {}) },
        transient: false,
      };
    } catch (e) {
      const c = classifyError(e, ac.signal.aborted);
      return {
        result: { output: "", failure: c.failure, usage },
        transient: c.transient,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const first = await tryOnce();
  if (!first.result.failure || !retry || !first.transient) return first.result;
  // Never retry a cancel the caller (or user) explicitly requested — retrying
  // would re-run work that was just aborted.
  if (opts.externalSignal?.aborted) return first.result;
  // Single retry on a transient failure (mirrors runSubagentWithRetry). The
  // failed first attempt still burned real tokens (largest exactly when it
  // timed out) — surface the SUM of both attempts, not just the second. The
  // warning is recomputed over the merged usage (the run's real final spend).
  const second = await tryOnce();
  const usage = mergeUsage(first.result.usage, second.result.usage);
  const budgetWarning = budgetWarningFor(usage, opts);
  return {
    ...second.result,
    usage,
    ...(budgetWarning ? { budgetWarning } : { budgetWarning: undefined }),
  };
}
