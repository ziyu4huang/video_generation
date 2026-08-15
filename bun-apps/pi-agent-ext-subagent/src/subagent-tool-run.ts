/**
 * Run-context threading + pure/IO helpers extracted from subagent-tool.ts's
 * `execute`. The orchestrator builds a `RunContext`, mutates a `RunProgress`
 * box from spawn callbacks, and delegates the capture/format/build steps here.
 * Behavior-preserving: every helper mirrors the exact swallow/gate semantics
 * of the inline code it replaces.
 */

import type { AgentHistoryEntry, BudgetWarning } from "@repo/pi-agent-ext-core-runtime";
import { parseSddReport } from "@repo/pi-agent-ext-core-runtime";
import type { TSchema } from "typebox";
import { tierDefaultToken } from "./budget-defaults.js";
import type { computeScopeCheck, GitScopeOps, SubagentScopeCheck } from "./git-scope.js";
import type { SpawnSubagentOptions, SubagentFailure } from "./spawn-subagent.js";
import { generateSubagentRunId, type SubagentRunPersistence } from "./subagent-run-persistence.js";
import { formatSubagentLive, taskPreview } from "./subagent-tool-render.js";
import { DEFAULT_TIMEOUT_MS, type SubagentToolDetails } from "./subagent-tool-schema.js";
import type { computeBaseline, RepoBaseline } from "./watchdog/repo-diff.js";
import { normalizeWatchdogParam, type WatchdogResult } from "./watchdog/types.js";
import type { runWatchdog } from "./watchdog/watchdog.js";

/** Watchdog opts type (non-null return of normalizeWatchdogParam). */
export type WatchdogOpts = NonNullable<ReturnType<typeof normalizeWatchdogParam>>;

/** Immutable per-run context, built in the execute preamble. */
export interface RunContext {
  t0: number;
  runCwd: string;
  spawnCwd: string;
  worktree?: unknown; // Worktree handle (opaque to this module)
  toolCallId: string;
  params: { task: string; agent?: string; commitScope?: string[]; [k: string]: unknown };
  agentDef?: { tools?: string[]; disallowedTools?: string[]; model?: string; tier?: string; prompt?: string };
  modelCtx: {
    requestedModel: string | undefined;
    tier: string | undefined;
    capability: string | undefined;
    mainModel: string | undefined;
    displayModelBeforeResolve: string;
  };
}

/** Mutable progress box — written ONLY from the spawn callbacks, read in teardown/save. */
export interface RunProgress {
  resolvedModel: string | undefined;
  fellBack: boolean;
  lastHistory: AgentHistoryEntry[] | undefined;
  maxToolCallsSeen: number;
}

// ---- pure helpers ----

/** Shown while the subagent runs, before the resolved model is known. */
export function resolveDisplayModel(
  requestedModel: string | undefined,
  capability: string | undefined,
  tier: string | undefined,
  mainModel: string | undefined,
): string {
  return requestedModel ?? (capability ? `capability:${capability}` : tier ? `tier:${tier}` : mainModel) ?? "default";
}

/** Phase E: capture repo HEAD before dispatch (real tree only). Swallows throw → undefined. */
export async function captureCommitBaseline(
  scope: string[] | undefined,
  spawnCwd: string,
  runCwd: string,
  gitOps: GitScopeOps,
): Promise<string | undefined> {
  // #02 B1: default-on. An UNSET scope is now treated as scope=[] (flag ANY
  // commit) instead of disabling the check — so we capture the baseline on the
  // real tree regardless of whether a scope was declared. The worktree-isolation
  // guard stays (a worktree run is discarded at teardown → can't pollute main).
  void scope;
  if (spawnCwd !== runCwd) return undefined;
  try {
    return await gitOps.headCommit(runCwd);
  } catch {
    return undefined;
  }
}

/** Phase K: post-run scope check (real tree + baseline only). Swallows throw → undefined. */
export async function runScopeCheck(
  scope: string[] | undefined,
  spawnCwd: string,
  runCwd: string,
  baseCommit: string | undefined,
  gitOps: GitScopeOps,
  compute: typeof computeScopeCheck,
): Promise<SubagentScopeCheck | undefined> {
  // #02 B1: default-on. Unset scope → [] (flag every committed path via
  // outOfScopePaths' empty-scope semantics). Worktree-isolation + missing
  // baseline guards stay. Never auto-reverts (git-scope.ts invariant).
  if (spawnCwd !== runCwd || baseCommit === undefined) return undefined;
  try {
    return await compute(gitOps, runCwd, baseCommit, scope ?? []);
  } catch {
    return undefined;
  }
}

/** Phase F: snapshot repo state for the watchdog. `undefined` ⇒ watchdog off / unavailable. */
export function captureWatchdogBaseline(
  spawnCwd: string,
  watchdogParam: unknown,
  compute: typeof computeBaseline,
): { opts: WatchdogOpts; baseline: RepoBaseline } | undefined {
  const opts = normalizeWatchdogParam(watchdogParam);
  if (!opts) return undefined;
  try {
    const baseline = compute(spawnCwd);
    if (!baseline) return undefined;
    return { opts, baseline };
  } catch {
    return undefined;
  }
}

/** Phase M: soft-gate review. Never throws — appends a summary or `watchdog-error:` line. */
export async function runWatchdogReview(
  run: typeof runWatchdog,
  opts: WatchdogOpts,
  baseline: RepoBaseline,
  spawnCwd: string,
  taskLabel: string,
): Promise<{ result?: WatchdogResult; outputAppend: string }> {
  try {
    const result = await run({ cwd: spawnCwd, before: baseline, opts, taskLabel });
    if (result.ran || result.editGated) {
      return { result, outputAppend: `\n\n--- 🔍 ${result.summary} (soft gate — review findings; not a failure) ---` };
    }
    return { result, outputAppend: "" };
  } catch (e) {
    return { result: undefined, outputAppend: `\n\n--- 🔍 watchdog-error: ${(e as Error).message} ---` };
  }
}

/** Phase L: surface a commit-scope violation into the result text. */
export function augmentOutputWithScopeViolation(output: string, scopeCheck: SubagentScopeCheck | undefined): string {
  if (scopeCheck && scopeCheck.outOfScope.length > 0) {
    const paths = scopeCheck.outOfScope.map((p) => `  - ${p}`).join("\n");
    return `${output}\n\n--- ⚠ commit-scope violation (${scopeCheck.outOfScope.length}) ---\nThe subagent committed path(s) OUTSIDE the declared commitScope:\n${paths}\nInspect before merging — this is the recurring \`git add -A\` sweep signal.`;
  }
  return output;
}

type SubagentRunRecord = Parameters<SubagentRunPersistence["save"]>[0];

/** Shared fields for the durable record (aborted + normal paths). */
export interface RunRecordCtx {
  toolCallId: string;
  agent: string | undefined;
  task: string;
  model: string;
  requestedModel: string | undefined;
  fellBack: boolean;
  tier: string | undefined;
  runCwd: string;
  t0: number;
  elapsedMs: number;
}

/** Per-path delta. Optional fields are omitted from the record when absent
 *  (matching the original literals' key sets; JSON-equivalent on serialize). */
export interface RunRecordDelta {
  status: SubagentToolDetails["status"];
  output: string;
  usage?: SubagentToolDetails["usage"];
  /** Why it failed (was `stderr`); omitted on the success path. */
  error?: string;
  budget?: SubagentToolDetails["budget"];
  turns?: SubagentToolDetails["turns"];
  history?: AgentHistoryEntry[];
  report?: SubagentToolDetails["report"];
  scopeCheck?: SubagentScopeCheck;
  watchdog?: WatchdogResult;
}

/** Unifies the two persistence.save literals (aborted L897–914 + normal L994–1017). */
export function buildRunRecord(ctx: RunRecordCtx, delta: RunRecordDelta): SubagentRunRecord {
  const rec: SubagentRunRecord = {
    id: generateSubagentRunId(),
    toolCallId: ctx.toolCallId,
    agent: ctx.agent,
    task: ctx.task,
    model: ctx.model,
    requestedModel: ctx.fellBack ? (ctx.requestedModel ?? undefined) : undefined,
    fellBack: ctx.fellBack || undefined,
    tier: ctx.tier,
    cwd: ctx.runCwd,
    status: delta.status,
    startedAt: new Date(ctx.t0).toISOString(),
    elapsedMs: ctx.elapsedMs,
    usage: delta.usage,
    output: delta.output,
  };
  if (delta.error !== undefined) rec.error = delta.error;
  if (delta.budget !== undefined) rec.budget = delta.budget;
  if (delta.turns !== undefined) rec.turns = delta.turns;
  if (delta.history !== undefined) rec.history = delta.history;
  if (delta.report !== undefined) rec.report = delta.report;
  if (delta.scopeCheck !== undefined) rec.scopeCheck = delta.scopeCheck;
  if (delta.watchdog !== undefined) rec.watchdog = delta.watchdog;
  return rec;
}

/** Phase N: the normal-completion details literal (L970–988). */
export function buildDetails(
  result: {
    failure?: SubagentFailure;
    usage?: SubagentToolDetails["usage"];
    /** Informational 80% warning from the spawn result — surfaced as details.budget.warning. */
    budgetWarning?: BudgetWarning;
    output: string;
  },
  model: { model: string; requestedModel: string | undefined; fellBack: boolean },
  extra: {
    task: string;
    agent?: string;
    elapsedMs: number;
    startedAt: number;
    scopeCheck?: SubagentScopeCheck;
    watchdog?: WatchdogResult;
  },
): SubagentToolDetails {
  const { failure } = result;
  return {
    agent: extra.agent,
    model: model.model,
    requestedModel: model.fellBack ? (model.requestedModel ?? undefined) : undefined,
    fellBack: model.fellBack || undefined,
    taskPreview: taskPreview(extra.task),
    elapsedMs: extra.elapsedMs,
    startedAt: extra.startedAt,
    status: failure?.kind ?? "done",
    usage: result.usage,
    // Exhaustion on the abort path; otherwise nest the informational 80%
    // warning as budget.warning (the two are mutually exclusive by
    // construction — a warned run completed, an aborted run carries no warning).
    budget:
      failure?.kind === "budget"
        ? failure.budget
        : result.budgetWarning
          ? { warning: result.budgetWarning }
          : undefined,
    turns: failure?.kind === "turns" ? failure.turns : undefined,
    report: parseSddReport(result.output),
    scopeCheck: extra.scopeCheck,
    watchdog: extra.watchdog,
  };
}

/** Phase I: the 48-line spawn config + its 3 progress-mutating callbacks (L838–886). */
export interface SpawnCtx {
  toolCallId: string;
  t0: number;
  params: Record<string, unknown> & {
    task: string;
    tools?: string[];
    excludeTools?: string[];
    timeoutMs?: number;
    tokenBudget?: number;
    spendBudget?: number;
    maxTurns?: number;
    retryOnTransient?: boolean;
    schema?: unknown;
    schemaRepairAttempts?: number;
  };
  agentDef?: { tools?: string[]; disallowedTools?: string[]; prompt?: string };
  modelCtx: {
    requestedModel: string | undefined;
    tier: string | undefined;
    capability: string | undefined;
    mainModel: string | undefined;
  };
  spawnCwd: string;
  childSignal: AbortSignal;
}
export interface SpawnDeps {
  getActiveTools?: () => string[] | undefined;
  getExtensionTools?: () => unknown[] | undefined;
  inFlight?:
    | {
        updateModel?: (id: string, m: string) => void;
        markFallback?: (id: string, spec: string) => void;
        update?: (id: string, h: AgentHistoryEntry[]) => void;
      }
    | undefined;
  persistence?: unknown;
  onUpdate?: unknown;
}

export function buildSpawnOptions(ctx: SpawnCtx, progress: RunProgress, deps: SpawnDeps): SpawnSubagentOptions {
  const { params, agentDef, modelCtx, spawnCwd, childSignal, t0, toolCallId } = ctx;
  const instructions =
    [ctx.params.agent ? `You are the ${ctx.params.agent} for this task.` : undefined, agentDef?.prompt]
      .filter((s): s is string => Boolean(s))
      .join("\n\n") || undefined;
  const defaultActiveTools = deps.getActiveTools?.();
  return {
    task: params.task,
    tools: params.tools ?? agentDef?.tools ?? defaultActiveTools,
    excludeTools: params.excludeTools ?? agentDef?.disallowedTools,
    model: modelCtx.requestedModel,
    tier: modelCtx.tier,
    capability: modelCtx.capability,
    mainModel: modelCtx.mainModel,
    cwd: spawnCwd,
    instructions,
    extensionTools: deps.getExtensionTools?.(),
    externalSignal: childSignal,
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // #01 tier-calibrated hard-abort default. An explicit tokenBudget always
    // wins; otherwise the ceiling is derived from the tier (or the model's tier
    // via reverse-map). spendBudget is intentionally NOT defaulted (cost≡0 on
    // this MLX stack — a spend ceiling can never fire).
    tokenBudget: params.tokenBudget ?? tierDefaultToken(modelCtx.tier, modelCtx.requestedModel ?? modelCtx.mainModel),
    spendBudget: params.spendBudget,
    // Turn cap: NO default (omit = unlimited turns) — unlike tokenBudget, which
    // is tier-calibrated per #01. Mirrors SpawnSubagentOptions.maxTurns.
    maxTurns: params.maxTurns,
    retryOnTransient: params.retryOnTransient,
    schema: params.schema as TSchema | undefined,
    schemaRepairAttempts: params.schemaRepairAttempts,
    onModelResolved: (id: string) => {
      progress.resolvedModel = id;
      deps.inFlight?.updateModel?.(toolCallId, id);
    },
    onModelFallback: (requestedSpec: string) => {
      progress.fellBack = true;
      deps.inFlight?.markFallback?.(toolCallId, requestedSpec);
    },
    onHistory:
      deps.onUpdate || deps.inFlight || deps.persistence
        ? (history: AgentHistoryEntry[]) => {
            progress.lastHistory = history;
            try {
              const toolCallsNow = history.filter((h) => h.kind === "toolCall").length;
              progress.maxToolCallsSeen = Math.max(progress.maxToolCallsSeen, toolCallsNow);
              deps.inFlight?.update?.(toolCallId, history);
              (deps.onUpdate as ((u: unknown) => void) | undefined)?.({
                content: [
                  {
                    type: "text" as const,
                    text: formatSubagentLive(history, Date.now() - t0, progress.maxToolCallsSeen),
                  },
                ],
                details: undefined as unknown as SubagentToolDetails,
              });
            } catch {
              // swallowed — progress streaming is diagnostic only
            }
          }
        : undefined,
  } as SpawnSubagentOptions;
}
