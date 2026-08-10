/**
 * Run-context threading + pure/IO helpers extracted from subagent-tool.ts's
 * `execute`. The orchestrator builds a `RunContext`, mutates a `RunProgress`
 * box from spawn callbacks, and delegates the capture/format/build steps here.
 * Behavior-preserving: every helper mirrors the exact swallow/gate semantics
 * of the inline code it replaces.
 */
import type { AgentHistoryEntry } from "./agent-history.js";
import { computeScopeCheck, type GitScopeOps, type SubagentScopeCheck } from "./git-scope.js";
import { computeBaseline, type RepoBaseline } from "./watchdog/repo-diff.js";
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
  if (scope === undefined || spawnCwd !== runCwd) return undefined;
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
  if (scope === undefined || spawnCwd !== runCwd || baseCommit === undefined) return undefined;
  try {
    return await compute(gitOps, runCwd, baseCommit, scope);
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
