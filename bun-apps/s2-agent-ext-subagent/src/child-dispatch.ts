/**
 * `dispatchChild` — the one place a single isolated child run is driven.
 *
 * Both LLM-facing tools dispatch children, and before this module each carried
 * its own copy of the same policy: derive a per-child AbortController, fan the
 * parent turn signal into it, register with the in-flight registry, capture the
 * ACTUAL resolved model (and any fallback), stream history, audit the child's
 * commits against a scope, distinguish a per-child user abort from a whole-turn
 * Esc, and derive a status. `subagents-tool.ts` carried ten "mirrors the singular
 * tool" comments to keep the two copies aligned by hand.
 *
 * Hand-alignment failed twice, both recorded in the code it replaces:
 *   - ticket 04 finding 2 — #1103's actual-model capture never reached the batch
 *     tool, so a batch child that fell back rendered the REQUESTED model under a
 *     ✓ done badge.
 *   - "#02 B1: default-on" made the commit-scope audit run even with no declared
 *     scope, but only on the singular path; the batch path still gated on an
 *     explicit `commitScope`, so the `git add -A` sweep signal it exists to catch
 *     was silently off for every batch child.
 *
 * What stays with the callers is what genuinely differs: building the spawn
 * options (agentType resolution, worktree isolation, the batch's non-overridable
 * read-only exclusion), the watchdog, the circuit breaker, and how a result is
 * rendered and persisted. This module owns the run, not the request.
 */

import type {
  AgentHistoryEntry,
  AgentUsage,
  SpawnSubagentOptions,
  SpawnSubagentResult,
  SubagentInFlightRegistry,
} from "@repo/s2-agent-core-runtime";
import { computeScopeCheck, type GitScopeOps, realGitOps, type SubagentScopeCheck } from "./git-scope.js";
import type { SubagentToolDetails } from "./subagent-tool-schema.js";

/** One child dispatch. The caller supplies a fully-built request; this module runs it. */
export interface ChildDispatchRequest {
  /** In-flight registry id — `toolCallId`, or `${toolCallId}:${index}` for a batch child. */
  id: string;
  /** Wall-clock dispatch start (epoch ms). */
  startedAt: number;
  /**
   * Spawn options MINUS the five fields this module owns: `externalSignal`,
   * `onModelResolved`, `onModelFallback`, `onHistory`, `onUsage`. Anything set
   * for those is overwritten — they are the seam, not caller configuration.
   */
  spawn: SpawnSubagentOptions;
  /** Display fields for the in-flight registry entry. */
  entry: {
    agent?: string;
    /** Requested/display model, shown until `onModelResolved` reports the real one. */
    model: string;
    taskPreview: string;
    workIntent: string;
    /** Set on a batch child so the viewer can group it under its batch. */
    batchId?: string;
    /** FULL raw task (Task 05): stored on the registry entry so a mid-flight
     *  detach can flush a resumable manifest with the real prompt. */
    task?: string;
  };
  /**
   * Commit-scope audit inputs. Omit to skip the audit entirely (the caller has
   * no repo context). Present with `declared: undefined` still audits — an unset
   * scope means "flag any commit", which is the `git add -A` sweep signal.
   */
  scope?: { declared?: string[]; runCwd: string; spawnCwd: string };
  /** Parent turn signal; fanned into the child controller so a whole-turn Esc propagates. */
  parentSignal?: AbortSignal;
}

export interface ChildDispatchDeps {
  spawn: (opts: SpawnSubagentOptions) => Promise<SpawnSubagentResult>;
  inFlight?: SubagentInFlightRegistry;
  /** Defaults to realGitOps. Only consulted when `request.scope` is set. */
  gitOps?: GitScopeOps;
  /** Wraps the provider dispatch — the batch tool passes the shared per-provider rate limiter. */
  gate?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Live history tick (already throttled to ≥250ms by the runner). */
  onHistory?: (history: AgentHistoryEntry[]) => void;
  /**
   * Capture history into `outcome.history` even with no live observer — set by a
   * caller that persists the transcript. No `onHistory` is attached to the spawn
   * at all unless this, `onHistory`, or `inFlight` asks for one, so a dispatch
   * nobody is watching does not pay for a stream nobody reads.
   */
  captureHistory?: boolean;
  /** Final usage, emitted once at completion. */
  onUsage?: (usage: AgentUsage) => void;
  /**
   * How to release the registry entry. `end` (default) evicts it; `markCompleted`
   * keeps it for k/N progress and a frozen trace, leaving eviction to the caller
   * (the batch tool evicts the whole group with `endBatch`).
   */
  release?: "end" | "markCompleted";
}

export interface ChildDispatchOutcome {
  result: SpawnSubagentResult;
  status: SubagentToolDetails["status"];
  /** True only for a per-child abort — a whole-turn Esc is NOT a user abort. */
  userAborted: boolean;
  /** The model that actually ran, else the requested display string. */
  model: string;
  /** The originally-requested spec, only when resolution fell back. */
  requestedModel?: string;
  fellBack: boolean;
  elapsedMs: number;
  /** Last history snapshot the runner reported (for the durable record). */
  history?: AgentHistoryEntry[];
  /** Commit-scope audit, when `request.scope` was supplied and the run used the real tree. */
  scopeCheck?: SubagentScopeCheck;
}

export async function dispatchChild(
  request: ChildDispatchRequest,
  deps: ChildDispatchDeps,
): Promise<ChildDispatchOutcome> {
  const { id, startedAt, entry } = request;
  const gitOps = deps.gitOps ?? realGitOps;
  const inFlight = deps.inFlight;

  // Per-child controller. A user abort of THIS child fires it directly (via the
  // registry entry's `abort`); a whole-turn Esc reaches it through the fan-in
  // below. spawn's own timeoutMs gate stays independent — it aborts spawn's
  // internal controller, so a timeout never looks like an abort here.
  const childAc = new AbortController();
  const onParentAbort = () => childAc.abort();
  if (request.parentSignal?.aborted) childAc.abort();
  else request.parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  // Task 05: when the run is detached to background mid-flight (registry
  // detached flip via convertToBackground), the awaited tool call resolves
  // with outcome "detached": the in-process run is aborted (superseded by the
  // detached OS subprocess — never double-work), the registry entry is NOT
  // released (it stays live with foreground=false), and the spawned child is
  // NOT killed (the detach pipeline owns it now; the rebound abort lever is
  // the only kill path). Test doubles may omit onDetach — guard the call.
  //
  // SUBSCRIBE AFTER start() below, in the same synchronous slice: the
  // registry treats an unknown id as an inert no-op subscription, so wiring
  // the watcher before the entry exists would silently drop the detach (the
  // awaited tool call would then never resolve). No detach can slip between
  // start and subscribe — convertToBackground refuses an unknown id, and
  // everything between the two calls is synchronous.
  let detached = false;
  let unsubscribeDetach: (() => void) | undefined;

  // Pre-dispatch repo HEAD. Real tree only: a worktree-isolated run is discarded
  // at teardown, so auditing it would be pure noise.
  let baseCommit: string | undefined;
  const auditable = request.scope !== undefined && request.scope.spawnCwd === request.scope.runCwd;
  if (auditable && request.scope) {
    try {
      baseCommit = await gitOps.headCommit(request.scope.runCwd);
    } catch {
      baseCommit = undefined; // best-effort — the audit never fails a run
    }
  }

  let resolvedModel: string | undefined;
  let requestedSpec: string | undefined;
  let fellBack = false;
  let history: AgentHistoryEntry[] | undefined;

  inFlight?.start({
    id,
    agent: entry.agent,
    model: entry.model,
    task: entry.task,
    taskPreview: entry.taskPreview,
    workIntent: entry.workIntent,
    startedAt,
    batchId: entry.batchId,
    abort: () => childAc.abort(),
    // Rendered inline by the owning tool's own call/result line, so the
    // above-editor context box excludes it (no duplication).
    foreground: true,
  } as Parameters<SubagentInFlightRegistry["start"]>[0]);
  const onDetach = () => {
    detached = true;
    childAc.abort();
  };
  if (typeof inFlight?.onDetach === "function") unsubscribeDetach = inFlight.onDetach(id, onDetach);

  let result: SpawnSubagentResult;
  try {
    const opts: SpawnSubagentOptions = {
      ...request.spawn,
      externalSignal: childAc.signal,
      onModelResolved: (modelId: string) => {
        resolvedModel = modelId;
        inFlight?.updateModel?.(id, modelId);
      },
      onModelFallback: (spec: string) => {
        fellBack = true;
        requestedSpec = spec;
        inFlight?.markFallback?.(id, spec);
      },
      onHistory:
        deps.onHistory || inFlight || deps.captureHistory
          ? (h: AgentHistoryEntry[]) => {
              history = h;
              // Diagnostic only: a throwing observer must never change the run's
              // outcome or fail the child.
              try {
                inFlight?.update?.(id, h);
                deps.onHistory?.(h);
              } catch {
                // swallowed
              }
            }
          : undefined,
      onUsage: (u: AgentUsage) => {
        try {
          deps.onUsage?.(u);
        } catch {
          // swallowed
        }
      },
    };
    const run = () => deps.spawn(opts);
    result = deps.gate ? await deps.gate(run) : await run();
  } finally {
    // Runs on throw too: a failed child must not leak its registry entry, and a
    // long batch must not accumulate one listener (and one retained controller
    // closure) per child on the parent turn signal. A DETACHED run is the one
    // exception: its entry must stay live (Task 05) — the detached subprocess
    // and the subagents section own it now.
    if (!detached) {
      if (deps.release === "markCompleted") inFlight?.markCompleted(id);
      else inFlight?.end(id);
    }
    request.parentSignal?.removeEventListener("abort", onParentAbort);
    unsubscribeDetach?.();
  }

  const elapsedMs = Date.now() - startedAt;
  // A user abort fires childAc only (parent signal intact); a whole-turn Esc
  // fans the parent signal INTO childAc, so the parent's own state distinguishes
  // them; a timeout leaves childAc un-aborted and falls through unchanged. A
  // DETACH also aborts childAc (superseded in-process run) but is neither.
  const userAborted = !detached && childAc.signal.aborted && !request.parentSignal?.aborted;

  // Post-run scope audit. Skipped for a worktree run or a missing baseline; an
  // unset `declared` scope means "flag any commit" via outOfScopePaths' empty-scope
  // semantics. Detection only — never reverts, never fails the run.
  let scopeCheck: SubagentScopeCheck | undefined;
  if (auditable && request.scope && baseCommit !== undefined) {
    try {
      scopeCheck = await computeScopeCheck(gitOps, request.scope.runCwd, baseCommit, request.scope.declared ?? []);
    } catch {
      scopeCheck = undefined;
    }
  }

  return {
    result,
    // `aborted` is the one status a spawn result cannot carry: the child sees a
    // cancelled run, only the parent turn knows the user asked for it.
    // `detached` (Task 05): the run was backgrounded mid-flight — the detached
    // subprocess owns execution, the parent turn resumes.
    status: detached ? "detached" : userAborted ? "aborted" : (result.failure?.kind ?? "done"),
    userAborted,
    model: resolvedModel ?? entry.model,
    requestedModel: fellBack ? requestedSpec : undefined,
    fellBack,
    elapsedMs,
    history,
    scopeCheck,
  };
}
