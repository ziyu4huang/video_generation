import { join } from "node:path";
import type { AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionOptions,
  createAgentSession,
  createCodingTools,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Check, Convert } from "typebox/value";
import { type AgentHistoryEntry, compactAgentHistory } from "./agent-history.js";
import { applyToolPolicy } from "./agent-registry.js";
import { classifyProviderLimit, WorkflowError, WorkflowErrorCode } from "./errors.js";
import { loadModelTierConfig, type ModelTierConfig, resolveTierModel, sortedTierNames } from "./model-tier-config.js";
import { parseSddReport, type SddReport } from "./sdd-report.js";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.js";

/**
 * Find a JSON object/array in free-form text: a fenced ```json block if present,
 * else the first balanced {...} or [...]. Best-effort (the schema check is the
 * real gate). Returns the raw JSON string, or undefined when none is found.
 */
function findJsonBlock(text: string): string | undefined {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) return fence[1].trim();
  const start = text.search(/[{[]/);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/**
 * Last-resort structured-output recovery: extract a JSON block from prose, coerce
 * it toward the schema, and accept it only if it then validates. Never fabricates
 * — returns undefined unless the parsed value genuinely satisfies the schema.
 */
export function extractValidated<T>(text: string, schema: TSchema): T | undefined {
  const json = findJsonBlock(text);
  if (json === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  try {
    const converted = Convert(schema, parsed);
    if (Check(schema, converted)) return converted as T;
  } catch {
    // typebox can throw on exotic schemas; treat as no match.
  }
  return undefined;
}

/**
 * The last assistant message's terminal metadata (stopReason/errorMessage). The pi
 * SDK does NOT throw provider usage/quota limits — it records them as an assistant
 * message with stopReason "error" and an errorMessage. This is the only place that
 * metadata is observable to the workflow layer.
 */
export function lastAssistantError(messages: unknown[]): { stopReason?: string; errorMessage?: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Partial<AssistantMessage> | undefined;
    if (message?.role !== "assistant") continue;
    return { stopReason: message.stopReason, errorMessage: message.errorMessage };
  }
  return undefined;
}

/**
 * If the subagent's turn ended in a provider usage/quota/rate-limit error, throw a
 * PROVIDER_USAGE_LIMIT WorkflowError carrying the real provider message + reset hint.
 * Gated on stopReason === "error" so a successful turn whose text merely mentions
 * "rate limit" is never misclassified. recoverable:false so the run checkpoints
 * (paused) rather than being retried into the same wall or collapsed to a silent null.
 */
export function throwIfProviderLimit(messages: unknown[], label?: string): void {
  const err = lastAssistantError(messages);
  if (err?.stopReason !== "error") return;
  const { matched, resetHint } = classifyProviderLimit(err.errorMessage);
  if (!matched) return;
  throw new WorkflowError(
    err.errorMessage ?? "Provider usage/quota limit reached",
    WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
    { recoverable: false, agentLabel: label, resetHint },
  );
}

/** Minimal session surface resolveStructuredOutput needs (real session or a test double). */
export interface StructuredSession {
  prompt(text: string): Promise<void>;
  setActiveToolsByName?(names: string[]): void;
  messages: unknown[];
}

/**
 * Resolve a schema agent's result. If the tool was called, return the captured
 * value. Otherwise re-prompt up to maxSchemaRetries (tools restricted to
 * structured_output), then try strict schema-validated prose extraction, else
 * throw SCHEMA_NONCOMPLIANCE (non-recoverable — surfaced, never a silent null).
 * Module-level with an injected `lastText` so it is unit-testable.
 */
export async function resolveStructuredOutput<T>(
  session: StructuredSession,
  capture: StructuredOutputCapture<T>,
  schema: TSchema,
  options: { maxSchemaRetries?: number; signal?: AbortSignal; label?: string },
  lastText: (messages: unknown[]) => string,
): Promise<T> {
  if (capture.called) return capture.value as T;

  const maxRetries = Math.max(0, options.maxSchemaRetries ?? 2);
  // Restrict to the schema tool so the only useful next action is calling it
  // (takes effect on the next prompt turn). Best-effort.
  try {
    session.setActiveToolsByName?.(["structured_output"]);
  } catch {
    // ignore — the re-prompt alone still drives most models to comply
  }
  for (let attempt = 0; attempt < maxRetries && !capture.called; attempt++) {
    if (options.signal?.aborted) throw new Error("Subagent was aborted");
    await session.prompt(
      "You did not call the structured_output tool. Call structured_output now as your only action, with the required fields filled in. Do not write a prose answer.",
    );
  }
  if (capture.called) return capture.value as T;

  const extracted = extractValidated<T>(lastText(session.messages), schema);
  if (extracted !== undefined) {
    console.warn(
      "[workflow] structured_output recovered from prose extraction (the model never called the tool); prefer a tool-reliable model",
    );
    return extracted;
  }

  // A repair re-prompt can itself hit the provider limit. Surface that as the real
  // (recoverable) cause instead of the misleading non-recoverable SCHEMA_NONCOMPLIANCE.
  throwIfProviderLimit(session.messages, options.label);

  throw new WorkflowError(
    "Subagent did not produce valid structured_output after repair attempts",
    WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
    { recoverable: false, agentLabel: options.label },
  );
}

/**
 * Resolve which concrete model spec a subagent should use. Precedence, most
 * specific first:
 *   1. options.model — an explicit per-agent model (also carries agentType /
 *      phase model, which the workflow layer folds into options.model).
 *   2. options.tier  — resolved via the model-tiers config, falling back to the
 *      session's main model when the tier has no configured entry (with a
 *      warning — see RCA#6: an unknown/misspelled tier must not silently
 *      escalate to the most expensive model).
 *   3. DEFAULT TIER — when neither is set but the user has a model-tiers config,
 *      untagged agents default to the "medium" tier so a configured tier set
 *      actually affects the whole workflow (not just agents the script tagged).
 *      Fresh-install medium == the session model, so this is a no-op until the
 *      user customizes tiers via /workflows-models.
 * Returns undefined when nothing applies, so the session default is used.
 *
 * `loadConfig` is injectable for testing; it defaults to reading from disk.
 */
export function resolveAgentModelSpec(
  options: { model?: string; tier?: string },
  mainModel: string | undefined,
  loadConfig: () => ModelTierConfig | null = loadModelTierConfig,
): string | undefined {
  if (options.model) return options.model;
  const config = loadConfig();
  if (options.tier) {
    const resolved = config ? resolveTierModel(options.tier, config) : undefined;
    if (resolved) return resolved;
    // RCA#6: an unknown/misspelled tier (or no tier config at all) used to fall
    // back to mainModel SILENTLY — often the most expensive model, so a typo
    // quietly escalated cost. Surface it so the degradation is visible.
    console.warn(
      `[workflow] unknown tier "${options.tier}"${config ? "" : " (no model-tiers config found)"} — falling back to the session default${mainModel ? ` (${mainModel})` : ""}. Configured tiers: ${config ? sortedTierNames(config).join(", ") || "(none)" : "(none)"}. Manage them via /workflows-models (or /models-preset to apply a full config).`,
    );
    return mainModel;
  }
  // Untagged agent: default to the configured medium tier when one exists.
  if (config) {
    const medium = resolveTierModel("medium", config);
    if (medium) return medium;
  }
  return undefined;
}

/**
 * Fallback decision when an explicitly-requested model spec turns out to be
 * UNavailable. The caller's `tier` (→ active /models-preset) degrades BEFORE
 * the session default, so subagents follow the preset by default instead of
 * silently landing on an arbitrary session default. (Previously an explicit
 * model short-circuited the tier, then the tier was discarded on fallback.)
 *
 * Pure + injectable (the async resolver + the tier config are passed in) so the
 * decision is unit-testable independent of the real ModelRegistry /
 * createAgentSession. Returns:
 *   - `{ kind: "tier", spec }` — a tier is set AND its preset model resolves in
 *     the registry; use `spec` as the fallback model.
 *   - `{ kind: "sessionDefault" }` — no tier, the tier isn't configured, or its
 *     model is also unavailable; use the session default.
 * `warning` is a loud one-line message naming requested → tier → actual (or →
 * session default) for the run log.
 */
export interface FallbackDecision {
  kind: "tier" | "sessionDefault";
  /** When `kind === "tier"`: the preset model spec to fall back to. */
  spec?: string;
  /** Loud one-line warning for the run log. */
  warning: string;
}

export async function resolveFallbackModel(
  requestedSpec: string,
  options: { tier?: string },
  config: ModelTierConfig | null,
  resolveModel: (spec: string) => Promise<unknown>,
): Promise<FallbackDecision> {
  if (options.tier && config) {
    const tierModelSpec = resolveTierModel(options.tier, config);
    if (tierModelSpec) {
      if (await resolveModel(tierModelSpec)) {
        return {
          kind: "tier",
          spec: tierModelSpec,
          warning: `[subagent] requested model "${requestedSpec}" unavailable; fell back to tier "${options.tier}" → "${tierModelSpec}" (active preset)`,
        };
      }
      return {
        kind: "sessionDefault",
        warning: `[subagent] requested model "${requestedSpec}" unavailable; tier "${options.tier}" → "${tierModelSpec}" also unavailable; using session default`,
      };
    }
    return {
      kind: "sessionDefault",
      warning: `[subagent] requested model "${requestedSpec}" unavailable; tier "${options.tier}" not configured in the active preset; using session default`,
    };
  }
  return {
    kind: "sessionDefault",
    warning: `[subagent] requested model "${requestedSpec}" unavailable; ${
      options.tier ? `tier "${options.tier}" has no model-tiers config to resolve; ` : "no tier given; "
    }using session default`,
  };
}

export interface WorkflowAgentOptions {
  cwd?: string;
  /** Extra tools available to the subagent in addition to the structured output tool. */
  tools?: ToolDefinition[];
  /**
   * Extension-registered tool definitions inherited from the parent session. Child
   * sessions created by createAgentSession() start with a fresh extension load from
   * disk and would NOT pick up programmatic ExtensionFactory tools (e.g. tools
   * registered via `-e` or pi.registerTool()) — this field bridges the gap so
   * workflow subagents can call the same extension tools the parent session has.
   */
  extensionTools?: ToolDefinition[];
  /** Override any createAgentSession option (model, authStorage, resourceLoader, etc.). */
  session?: Partial<CreateAgentSessionOptions>;
  /** Extra system guidance prepended to every subagent task. */
  instructions?: string;
  /**
   * The session's main model (`provider/modelId`). Used as a fallback when
   * resolving opts.tier and no model-tiers.json config exists. Without this,
   * a workflow using `{ tier: "small" }` would log a warning and fall through
   * to the session default when no config is saved yet.
   */
  mainModel?: string;
  /**
   * Loads the model-tier config (model-tiers.json). Defaults to a disk read via
   * loadModelTierConfig; the result is cached per CoreAgent instance so a
   * run with many default/untagged agents does not re-read disk every call.
   * Injectable for tests (e.g. a counting loader to assert the cache).
   */
  loadTierConfig?: () => ModelTierConfig | null;
}

/**
 * List the user's currently available models (those with auth configured) as
 * `provider/modelId` specs. Used to tell the workflow author which models it may
 * route agents to. Best-effort: returns [] if the registry can't be built.
 */
export async function listAvailableModelSpecs(): Promise<string[]> {
  try {
    const dir = getAgentDir();
    const runtime = await ModelRuntime.create({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
    });
    const registry = new ModelRegistry(runtime);
    return registry.getAvailable().map((m) => `${m.provider}/${m.id}`);
  } catch {
    return [];
  }
}

/** Real token/cost usage for a single subagent run, read from the SDK session. */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

/** Why a budget-capped subagent run was aborted mid-run. */
export interface BudgetExhaustion {
  /** Which budget was exceeded. */
  kind: "tokens" | "spend";
  /** The caller-declared ceiling. */
  limit: number;
  /** The cumulative usage at the moment of abort. */
  actual: number;
}

/**
 * Pure: check cumulative session usage against an optional per-run budget.
 * Returns the first exceeded budget (tokens checked before spend), or
 * `undefined` when neither is set or neither is exceeded. Uses `>` (strictly
 * greater), so reaching the limit exactly is allowed. Extracted from
 * `CoreAgent.run` so the threshold logic is unit-testable independent of
 * the session/subscribe wiring (which mirrors the existing onHistory/timeout
 * seams and is exercised via the spawnSubagent classification tests).
 */
export function checkBudgetExhaustion(
  stats: { tokens: { total: number }; cost: number },
  budget: { tokenBudget?: number; spendBudget?: number },
): BudgetExhaustion | undefined {
  if (budget.tokenBudget !== undefined && stats.tokens.total > budget.tokenBudget) {
    return { kind: "tokens", limit: budget.tokenBudget, actual: stats.tokens.total };
  }
  if (budget.spendBudget !== undefined && stats.cost > budget.spendBudget) {
    return { kind: "spend", limit: budget.spendBudget, actual: stats.cost };
  }
  return undefined;
}

export interface BudgetGuardSession {
  /** Cumulative usage for this session; may throw before the first turn. */
  getSessionStats(): { tokens: { total: number }; cost: number };
  /** Hard-stop the in-flight session (existing abort semantics). */
  abort(): void;
  /** Queue/deliver a user-role message (followUp = next turn). */
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): Promise<void>;
}

export interface BudgetGuard {
  /** Subscribe-seam callback; call on each session state change. */
  check(): void;
  /** The exhaustion that caused the hard abort, if any. */
  readonly exhausted: BudgetExhaustion | undefined;
  /** Whether the one-shot wrap-up message was already issued. */
  readonly wrapUpIssued: boolean;
}

/**
 * The single wrap-up notice injected on the FIRST tokenBudget crossing. The
 * model sees it as a user message on its next (final) turn: flush state to
 * disk, then reply with a pointer — instead of being killed mid-flight and
 * losing everything it had learned.
 */
export const BUDGET_WRAP_UP_MESSAGE =
  "Token budget exhausted — this is your FINAL turn. Do not start new exploratory work or long tool calls. Write your current findings/state/artifacts to disk now (files, not prose), then reply with a one-line pointer to what you saved.";

/**
 * Two-stage budget stop wired into the session's subscribe seam.
 *
 * - spendBudget is a money valve: it ALWAYS hard-aborts (no wrap-up turn).
 * - tokenBudget gets ONE grace turn: the first crossing injects
 *   BUDGET_WRAP_UP_MESSAGE as a followUp user message (the model flushes its
 *   state to disk); the SECOND crossing aborts for real, bit-for-bit the
 *   pre-wrap-up behavior (abort + BudgetExhausted → status "budget").
 * - If BOTH budgets cross at once, the hard abort wins.
 *
 * Extracted from CoreAgent.run so the two-stage decision is unit-testable
 * against a fake session (same pattern as checkBudgetExhaustion).
 */
export function createBudgetGuard(
  session: BudgetGuardSession,
  budget: { tokenBudget?: number; spendBudget?: number },
): BudgetGuard {
  let budgetExhausted: BudgetExhaustion | undefined;
  let budgetWrapUpIssued = false;
  const check = () => {
    if (budgetExhausted) return;
    try {
      const { tokens, cost } = session.getSessionStats();
      const exhaustion = checkBudgetExhaustion({ tokens: { total: tokens.total }, cost }, budget);
      if (!exhaustion) return;
      // Hard-abort unless this is the FIRST tokenBudget crossing with no spend
      // crossing — only tokenBudget earns a wrap-up turn.
      const spendAlsoExceeded = budget.spendBudget !== undefined && cost > budget.spendBudget;
      if (exhaustion.kind === "tokens" && !budgetWrapUpIssued && !spendAlsoExceeded) {
        budgetWrapUpIssued = true;
        // followUp queues the message for the model's NEXT turn (we are inside
        // the streaming loop); that turn runs, and the turn-end check after it
        // hits the flag-set path and aborts for real.
        void session.sendUserMessage(BUDGET_WRAP_UP_MESSAGE, { deliverAs: "followUp" }).catch(() => {
          // Could not queue the wrap-up turn — fall back to the hard abort
          // so the budget is still enforced.
          budgetExhausted = exhaustion;
          session.abort();
        });
        return;
      }
      budgetExhausted = exhaustion;
      session.abort();
    } catch {
      // getSessionStats not available yet (e.g. before the first turn) — skip.
    }
  };
  return {
    check,
    get exhausted() {
      return budgetExhausted;
    },
    get wrapUpIssued() {
      return budgetWrapUpIssued;
    },
  };
}

export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
  label?: string;
  schema?: TSchemaDef;
  tools?: ToolDefinition[];
  instructions?: string;
  /**
   * Image attachments for a vision-capable subagent (e.g. a VLM page-extraction
   * call). Threaded to session.prompt's `{images}`; each item is an image object
   * shaped per the host SDK (e.g. {type:"image",data,mimeType}). Omit for text-only.
   */
  images?: unknown[];
  signal?: AbortSignal;
  /**
   * Abort the session mid-run once cumulative token usage (`tokens.total`)
   * exceeds this. Checked on each session state change (per-turn granularity),
   * so an in-flight turn may overshoot by up to one turn. Two-stage stop: the
   * FIRST crossing injects a final-turn wrap-up notice (flush state to disk)
   * and lets exactly one more turn run; the SECOND crossing aborts for real.
   * Bounds a SINGLE runaway subagent — distinct from workflow's run-wide
   * `tokenBudget` (a between-agent soft gate that never aborts an in-flight
   * agent).
   */
  tokenBudget?: number;
  /**
   * Abort the session mid-run once cumulative cost ($) exceeds this. A money
   * valve: ALWAYS hard-aborts immediately — no wrap-up turn (unlike
   * tokenBudget). If both budgets cross at once, this hard stop wins.
   */
  spendBudget?: number;
  /**
   * Called once with this subagent's real usage, read from the session right
   * before disposal. Fires on both the success and error paths so partial
   * usage is never lost. `total === 0` means the provider reported no usage.
   */
  onUsage?: (usage: AgentUsage) => void;
  /**
   * Model spec for this subagent: either `provider/modelId` (unambiguous) or a
   * bare `modelId`. When it can't be resolved, the session default is used and
   * a warning is logged. When omitted, the session default applies.
   */
  model?: string;
  /**
   * Model tier name (e.g. "small", "medium", "big"). When set (and no explicit
   * `model` is given), the model is resolved from the user's model-tiers.json
   * config before `run()` starts, falling back to the session's main model when
   * the tier has no configured entry. An explicit `model` always takes priority,
   * so workflow scripts can use `{ tier: "small" }` for coarse routing without
   * caring which concrete model backs that tier.
   */
  tier?: string;
  /** Called with the resolved model id once known (for display/telemetry). */
  onModelResolved?: (modelId: string) => void;
  /** Called when `model`/`tier`/phase resolved to a spec that wasn't found (fell back to session default). */
  onModelFallback?: (requestedSpec: string) => void;
  /** Called with a compact snapshot of this subagent's message/tool history. */
  onHistory?: (history: AgentHistoryEntry[]) => void;
  /**
   * Parsed SDD self-report block (parity with the `subagent` tool's
   * `details.report`), when the agent's text output carries one. Fires on the
   * text-success path with `parseSddReport(text)` — `undefined` when no block
   * is present, and never fired for structured-output agents (no prose) or on
   * error. Lets a workflow collect each agent's SDD status without re-parsing.
   */
  onSddReport?: (report: SddReport | undefined) => void;
  /** Run this agent in a different working directory (e.g. an isolated worktree). */
  cwd?: string;
  /**
   * Restrict the subagent's coding tools to these names (an agentType
   * definition's `tools` allowlist). Undefined = all coding tools. The
   * structured_output tool is always added after this filter, so a schema
   * still works under a restrictive allowlist.
   */
  toolNames?: string[];
  /** Remove these coding-tool names after the allowlist (an agentType `disallowedTools` denylist). */
  disallowedToolNames?: string[];
  /**
   * With `schema`: how many extra repair turns to allow if the model finishes
   * without calling structured_output. Each retry re-prompts (tools restricted to
   * structured_output) before falling back to strict prose extraction. Default 2.
   */
  maxSchemaRetries?: number;
}

export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema
  ? Static<TSchemaDef>
  : string;

export class CoreAgent {
  private readonly cwd: string;
  private readonly baseTools: ToolDefinition[];
  private readonly extensionTools: ToolDefinition[];
  private readonly sessionOptions: Partial<CreateAgentSessionOptions>;
  private readonly instructions?: string;
  private readonly mainModel?: string;
  /** Lazily built once; shares the SDK's agentDir/auth so resolved models are authed. */
  private registryPromise?: Promise<ModelRegistry>;
  /**
   * Lazily loaded once per instance. `undefined` = not yet read; `null` = read
   * and the file is absent (callers fall back to a default). Caching avoids an
   * O(agents) disk read of model-tiers.json for default/untagged agents.
   */
  private tierConfigCache?: ModelTierConfig | null;
  private readonly loadTierConfigFn: () => ModelTierConfig | null;

  constructor(options: WorkflowAgentOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.baseTools = options.tools ?? createCodingTools(this.cwd);
    this.extensionTools = options.extensionTools ?? [];
    this.sessionOptions = options.session ?? {};
    this.instructions = options.instructions;
    this.mainModel = options.mainModel;
    this.loadTierConfigFn = options.loadTierConfig ?? loadModelTierConfig;
  }

  /** Cached model-tier config, read from disk at most once per instance. */
  private getTierConfig(): ModelTierConfig | null {
    if (this.tierConfigCache === undefined) {
      this.tierConfigCache = this.loadTierConfigFn();
    }
    return this.tierConfigCache;
  }

  private getRegistry(): Promise<ModelRegistry> {
    if (!this.registryPromise) {
      const dir = getAgentDir();
      // Same agentDir/auth files createAgentSession uses by default, so a model
      // resolved here carries valid credentials.
      this.registryPromise = ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: join(dir, "models.json"),
      }).then((runtime) => new ModelRegistry(runtime));
    }
    return this.registryPromise;
  }

  /**
   * Resolve a model spec to a Model. Accepts `provider/modelId` (unambiguous)
   * or a bare `modelId` (prefers auth-configured models, then any known model).
   * Returns undefined when nothing matches.
   */
  private async resolveModel(spec: string): Promise<Model<any> | undefined> {
    const registry = await this.getRegistry();
    const slash = spec.indexOf("/");
    if (slash > 0) {
      return registry.find(spec.slice(0, slash), spec.slice(slash + 1));
    }
    return registry.getAvailable().find((m) => m.id === spec) ?? registry.getAll().find((m) => m.id === spec);
  }

  async run<TSchemaDef extends TSchema | undefined = undefined>(
    prompt: string,
    options: AgentRunOptions<TSchemaDef> = {},
  ): Promise<AgentRunResult<TSchemaDef>> {
    const capture: StructuredOutputCapture<any> = { called: false, value: undefined };
    // Per-call cwd (e.g. a worktree) needs coding tools bound to that directory,
    // since tools capture their cwd at construction and can't be relocated.
    const runCwd = options.cwd ?? this.cwd;
    const baseTools = runCwd === this.cwd ? this.baseTools : createCodingTools(runCwd);
    // Apply the agentType tool policy BEFORE adding structured_output, so a
    // restrictive allowlist never strips the schema tool.
    const customTools: ToolDefinition[] = applyToolPolicy(
      [...baseTools, ...this.extensionTools, ...(options.tools ?? [])],
      options.toolNames,
      options.disallowedToolNames,
    );

    if (options.schema) {
      customTools.push(createStructuredOutputTool({ schema: options.schema, capture }) as unknown as ToolDefinition);
    }

    // Resolve the model spec (explicit model > tier > session default). This
    // composes with phase-based routing in workflow.ts, which only supplies
    // options.model when a phase pattern matches — so an explicit model wins.
    // The tier config is read from the instance cache (once per agent) instead
    // of re-reading disk on every call.
    const modelSpec = resolveAgentModelSpec(options, this.mainModel, () => this.getTierConfig());

    // Resolve a requested model spec to a Model object. A given-but-unresolved
    // spec degrades to the caller's tier (→ active /models-preset) BEFORE the
    // session default, with a loud warning — so subagents follow the preset by
    // default instead of silently landing on an arbitrary session default.
    let resolvedModel: Model<any> | undefined;
    let modelFallbackSpec: string | undefined;
    if (modelSpec) {
      resolvedModel = await this.resolveModel(modelSpec);
      if (resolvedModel) {
        options.onModelResolved?.(`${resolvedModel.provider}/${resolvedModel.id}`);
      } else {
        // The explicit model is unavailable. Fire the fellBack flag (ticket-03
        // display) in ALL fallback cases, then degrade to the caller's tier
        // (active preset) before the session default.
        options.onModelFallback?.(modelSpec);
        const decision = await resolveFallbackModel(modelSpec, options, this.getTierConfig(), (spec) =>
          this.resolveModel(spec),
        );
        console.warn(decision.warning);
        if (decision.kind === "tier" && decision.spec) {
          // The preset's tier model resolved — run on it and report it as the
          // ACTUAL model (display + record). modelFallbackSpec stays unset so
          // the post-session block does NOT re-emit onModelResolved.
          resolvedModel = await this.resolveModel(decision.spec);
          if (resolvedModel) {
            options.onModelResolved?.(`${resolvedModel.provider}/${resolvedModel.id}`);
          } else {
            // Edge: resolved in the predicate but not now (no-op in-memory race)
            // — fall through to the session default rather than running modelless.
            modelFallbackSpec = modelSpec;
          }
        } else {
          // No tier, or the tier's model is also unavailable → session default.
          // The post-session block emits the session's actual model (ticket-03).
          modelFallbackSpec = modelSpec;
        }
      }
    }

    const agentDir = getAgentDir();
    const { session } = await createAgentSession({
      cwd: runCwd,
      agentDir,
      sessionManager: SessionManager.inMemory(),
      // Use real SettingsManager to inherit user's default provider/model settings.
      // SettingsManager.inMemory() doesn't load ~/.pi/settings.json, so subagents
      // would fall back to the first available model (e.g. openai-codex) which may
      // not have valid auth, causing silent empty responses.
      settingsManager: SettingsManager.create(this.cwd, agentDir),
      customTools,
      ...this.sessionOptions,
      // Per-call model wins over any sessionOptions.model.
      ...(resolvedModel ? { model: resolvedModel } : {}),
    });

    // On fallback, emit the ACTUAL model the session resolved to so downstream
    // (display + durable record) learns what actually ran — not just the
    // requested-but-unavailable spec. `session.model` reflects the session's
    // resolved default after createAgentSession.
    if (modelFallbackSpec) {
      const actualModel = session.model;
      if (actualModel) {
        options.onModelResolved?.(`${actualModel.provider}/${actualModel.id}`);
      }
    }

    let removeAbortListener: (() => void) | undefined;
    let removeHistoryListener: (() => void) | undefined;
    let lastHistoryEmit = 0;
    const emitHistory = () => options.onHistory?.(compactAgentHistory(session.messages));
    const maybeEmitHistory = () => {
      if (!options.onHistory) return;
      const now = Date.now();
      if (now - lastHistoryEmit < 250) return;
      lastHistoryEmit = now;
      emitHistory();
    };
    // Per-run token/spend budget (tokenBudget/spendBudget): stop the session
    // once cumulative usage exceeds the ceiling. Checked on each session state
    // change (the same subscribe seam as onHistory), so overshoot is bounded to
    // ~one turn. Distinct from workflow's run-wide soft gate — this bounds a
    // single runaway subagent. spendBudget hard-aborts immediately (money
    // valve); tokenBudget gets a two-stage stop via createBudgetGuard — one
    // wrap-up turn (flush-to-disk notice injected as a followUp user message)
    // before the real abort. session.abort() makes session.prompt() return
    // (same contract as the signal/timeout abort below).
    const hasBudget = options.tokenBudget !== undefined || options.spendBudget !== undefined;
    const budgetGuard = createBudgetGuard(session, {
      tokenBudget: options.tokenBudget,
      spendBudget: options.spendBudget,
    });
    try {
      if (options.signal?.aborted) throw new Error("Subagent was aborted");
      if (options.signal) {
        const onAbort = () => void session.abort();
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
      }
      if (options.onHistory || hasBudget) {
        removeHistoryListener = session.subscribe(() => {
          maybeEmitHistory();
          budgetGuard.check();
        });
      }

      await session.prompt(
        this.buildPrompt(prompt, options as AgentRunOptions<any>, Boolean(options.schema)),
        options.images ? ({ images: options.images } as any) : undefined,
      );
      // Budget exhaustion aborts the session directly (not via the caller's
      // signal), so detect it via the flag BEFORE the signal-abort check and
      // surface it as a non-recoverable TOKEN_BUDGET_EXHAUSTED — retrying would
      // just re-exhaust the same budget. Distinct from a user/timeout abort.
      if (budgetGuard.exhausted) {
        const budgetExhausted = budgetGuard.exhausted;
        const unit =
          budgetExhausted.kind === "tokens"
            ? `${budgetExhausted.actual} tokens`
            : `$${budgetExhausted.actual.toFixed(4)}`;
        throw new WorkflowError(
          `subagent ${budgetExhausted.kind} budget exhausted (${unit} > limit ${budgetExhausted.limit})`,
          WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
          { recoverable: false, agentLabel: options.label, details: budgetExhausted },
        );
      }
      if (options.signal?.aborted) throw new Error("Subagent was aborted");

      // The SDK buries a provider usage/quota limit in the assistant message rather
      // than throwing; detect it here (before the schema/empty-text branches) so it
      // is classified as a recoverable checkpoint, not a SCHEMA_NONCOMPLIANCE failure
      // (schema path) or a silent empty-output null (non-schema path).
      throwIfProviderLimit(session.messages, options.label);

      if (options.schema) {
        return (await resolveStructuredOutput(session, capture, options.schema, options, (m) =>
          this.lastAssistantText(m),
        )) as AgentRunResult<TSchemaDef>;
      }

      const text = this.lastAssistantText(session.messages);
      if (!text.trim()) {
        throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
          recoverable: true,
          agentLabel: options.label,
        });
      }
      options.onSddReport?.(parseSddReport(text));
      return text as AgentRunResult<TSchemaDef>;
    } finally {
      removeAbortListener?.();
      removeHistoryListener?.();
      try {
        emitHistory();
      } catch {
        // History is diagnostic only; never let it mask the real result/error.
      }
      // Read real usage before disposing — dispose tears down the session state.
      if (options.onUsage) {
        try {
          const { tokens, cost } = session.getSessionStats();
          options.onUsage({
            input: tokens.input,
            output: tokens.output,
            cacheRead: tokens.cacheRead,
            cacheWrite: tokens.cacheWrite,
            total: tokens.total,
            cost,
          });
        } catch {
          // Usage is best-effort; never let stats failure mask the real result/error.
        }
      }
      session.dispose();
    }
  }

  private buildPrompt(prompt: string, options: AgentRunOptions<any>, structured: boolean): string {
    const parts = [
      this.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt,
    ].filter(Boolean);

    if (structured) {
      parts.push(
        [
          "Final output contract:",
          "- Your final action MUST be a structured_output tool call.",
          "- The structured_output arguments are the return value of this subagent.",
          "- Do not emit a prose final answer instead of structured_output.",
          "- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
        ].join("\n"),
      );
    }

    return parts.join("\n\n");
  }

  private lastAssistantText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as Partial<AssistantMessage> | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const text = message.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text.trim()) return text;
    }
    return "";
  }
}
