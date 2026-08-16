/**
 * Run-context threading + pure/IO helpers extracted from subagent-tool.ts's
 * `execute`. The orchestrator builds a `RunContext`, mutates a `RunProgress`
 * box from spawn callbacks, and delegates the capture/format/build steps here.
 * Behavior-preserving: every helper mirrors the exact swallow/gate semantics
 * of the inline code it replaces.
 */

import type { AgentHistoryEntry, BudgetWarning } from "@repo/pi-agent-core-runtime";
import { parseSddReport } from "@repo/pi-agent-core-runtime";
import type { TSchema } from "typebox";
import { tierDefaultToken } from "./budget-defaults.js";
import type { computeScopeCheck, GitScopeOps, SubagentScopeCheck } from "./git-scope.js";
import { deriveTaskLabel, type SpawnSubagentOptions, type SubagentFailure } from "./spawn-subagent.js";
import { generateSubagentRunId, type SubagentRunPersistence } from "./subagent-run-persistence.js";
import { formatSubagentLive, taskPreview } from "./subagent-tool-render.js";
import { DEFAULT_TIMEOUT_MS, type SubagentSalvage, type SubagentToolDetails } from "./subagent-tool-schema.js";
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

// ---- terminal-abort salvage (2026-08-15 hardening H2) ----

const SALVAGE_WRITE_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch"]);
const SALVAGE_MAX_TEXT = 1500;
const SALVAGE_MAX_FILES = 40;

/**
 * Extract what an aborted child managed to produce from its compact
 * transcript: the LAST assistant text (role assistant + kind text, trimmed,
 * ≤1500 chars) plus the paths touched by write tool calls (edit/write/
 * multiedit/apply_patch — parsed from the toolCall entry's JSON-stringified
 * arguments via the first write-tool arg key found; parse errors swallowed).
 * Deduped, ≤40 files. Returns undefined when the history holds neither (or is
 * absent) — a "done" run's real output already carries everything.
 */
export function extractSalvage(history: AgentHistoryEntry[] | undefined): SubagentSalvage | undefined {
  if (!history || history.length === 0) return undefined;
  let lastText: string | undefined;
  const files: string[] = [];
  const seen = new Set<string>();
  for (const h of history) {
    if (h.role === "assistant" && h.kind === "text" && h.text.trim()) lastText = h.text.trim();
    if (h.kind === "toolCall" && h.toolName && SALVAGE_WRITE_TOOLS.has(h.toolName)) {
      try {
        const args = JSON.parse(h.text) as Record<string, unknown>;
        const p = args.path ?? args.file_path;
        if (typeof p === "string" && p && !seen.has(p)) {
          seen.add(p);
          files.push(p);
        }
      } catch {
        // malformed toolCall args — nothing salvageable from this entry
      }
    }
  }
  const salvage: SubagentSalvage = {};
  if (lastText) salvage.lastText = lastText.length > SALVAGE_MAX_TEXT ? lastText.slice(0, SALVAGE_MAX_TEXT) : lastText;
  if (files.length > 0) salvage.files = files.slice(0, SALVAGE_MAX_FILES);
  return salvage.lastText || salvage.files ? salvage : undefined;
}

/**
 * Surface salvage into the parent-visible output — ONLY on a terminal abort
 * (failure kind budget/turns/timedout, or a user abort via `userAborted`),
 * where formatSubagentResult otherwise drops the child's last words and the
 * parent reads a bare abort line ("(empty)" via subagent_runs). Never fires
 * on "done" — the real output already carries it (no duplication).
 */
export function augmentOutputWithSalvage(
  output: string,
  failure: SubagentFailure | undefined,
  userAborted: boolean,
  salvage: SubagentSalvage | undefined,
): string {
  const terminal =
    userAborted || failure?.kind === "budget" || failure?.kind === "turns" || failure?.kind === "timedout";
  if (!salvage || !terminal) return output;
  const parts: string[] = [];
  if (salvage.files?.length) parts.push(`files touched: ${salvage.files.join(", ")}`);
  if (salvage.lastText) parts.push(`last words:\n${salvage.lastText}`);
  return `${output}\n\n--- salvage (terminal abort) ---\n${parts.join("\n")}`;
}

// ---- abort-safety prompt footer (2026-08-15 hardening H4) ----

const WRITE_TOOL_NAMES = new Set(["edit", "write", "multiedit", "apply_patch", "bash"]);

/**
 * Whether the child's effective toolset can mutate the repo (a write tool not
 * denied by excludeTools). An UNRESTRICTED child (no allowlist) reads as true
 * — bash/edit are available in that case.
 */
export function hasWriteTools(tools: string[] | undefined, excludeTools?: string[]): boolean {
  if (!tools) return true;
  const denied = new Set(excludeTools ?? []);
  return tools.some((t) => WRITE_TOOL_NAMES.has(t) && !denied.has(t));
}

/** Footer gate: write-capable child OR a long (maxTurns>10) run. */
export function shouldInjectFooter(ctx: { tools?: string[]; excludeTools?: string[]; maxTurns?: number }): boolean {
  return hasWriteTools(ctx.tools, ctx.excludeTools) || (ctx.maxTurns ?? 0) > 10;
}

/** Run-scoped progress-log path cited by the abort-safety footer. */
export function abortSafetyLogPath(toolCallId: string): string {
  return `/tmp/subagent-runs/${toolCallId}.md`;
}

/**
 * ≤6-line footer appended to the SPAWNED task (never the persisted
 * params.task) for write-capable or long dispatches. Mandates the three
 * behaviors that make an aborted child recoverable: a run-scoped progress log
 * written as-you-go, shell-level timeouts + orphan cleanup, and
 * report-to-log BEFORE replying at the limits.
 */
export function abortSafetyFooter(logPath: string): string {
  return [
    "",
    "--- abort-safety (appended by the dispatch layer — obey; don't restate) ---",
    `- Append progress/findings to ${logPath} as you go (create the file and its dir if missing).`,
    "- Wrap long shell commands in `timeout <seconds> <cmd>`; kill orphan processes you spawn.",
    "- Near your turn/budget limits, FIRST write your final report to that log file, then reply.",
  ].join("\n");
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
/** Durable-record statuses only — "detached" (Task 05) writes no completed
 * record in the parent, so the durable union excludes it. */
export type DurableRunStatus = Exclude<SubagentToolDetails["status"], "detached">;

export interface RunRecordDelta {
  /** Durable-record statuses only — "detached" is excluded by design (Task 05):
   * a detached run writes NO completed record in the parent; the detached
   * subprocess owns execution and its eventual completed-record write. */
  status: DurableRunStatus;
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
  salvage?: SubagentSalvage;
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
  if (delta.salvage !== undefined) rec.salvage = delta.salvage;
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
    salvage?: SubagentSalvage;
  },
): SubagentToolDetails & { status: DurableRunStatus } {
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
    salvage: extra.salvage,
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
    scopedModels: readonly string[] | undefined;
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
        accrueUsage?: (id: string, delta: { costUsd: number; tokensIn: number; tokensOut: number }) => void;
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
  const effectiveTools = params.tools ?? agentDef?.tools ?? defaultActiveTools;
  const effectiveExcludeTools = params.excludeTools ?? agentDef?.disallowedTools;
  // H4: append the abort-safety footer to the SPAWNED task only — params.task
  // (persisted task / taskSignature circuit-breaker input) stays raw, so both
  // sides of the signature comparison keep seeing the identical string.
  const task = shouldInjectFooter({
    tools: effectiveTools,
    excludeTools: effectiveExcludeTools,
    maxTurns: params.maxTurns,
  })
    ? `${params.task}${abortSafetyFooter(abortSafetyLogPath(toolCallId))}`
    : params.task;
  return {
    task,
    // H1: real per-task label (was a hardcoded "zk-spawn" leaking into every
    // child's status and error messages).
    label: deriveTaskLabel(params.task),
    tools: effectiveTools,
    excludeTools: effectiveExcludeTools,
    model: modelCtx.requestedModel,
    tier: modelCtx.tier,
    capability: modelCtx.capability,
    mainModel: modelCtx.mainModel,
    scopedModels: modelCtx.scopedModels,
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
    onUsage: (u) => {
      // Task 03: accrue the child's reported usage (AgentUsage: input/output/
      // cost) into the registry record so RunView carries live costUsd/tokensIn/
      // tokensOut (frozen at terminal by accrueUsage itself). The registry
      // no-ops for unknown ids, so this is safe even when inFlight is absent.
      deps.inFlight?.accrueUsage?.(toolCallId, {
        costUsd: u.cost ?? 0,
        tokensIn: u.input ?? 0,
        tokensOut: u.output ?? 0,
      });
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
