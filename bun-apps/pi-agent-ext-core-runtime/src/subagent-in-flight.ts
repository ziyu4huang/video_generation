/**
 * Live registry of in-flight `subagent` tool runs.
 *
 * The `/subagents` viewer (subagent-viewer.ts) shows COMPLETED runs
 * reconstructed from the session branch (reconstructSubagentRuns). This
 * registry adds the RUNNING ones: the subagent tool registers on start,
 * streams history, and deregisters on completion, so `/subagents` can show a
 * "Running" section with live elapsed while a child is mid-flight — closing
 * the gap that running subagents were invisible until they finished.
 */

import type { AgentHistoryEntry } from "./agent-history.js";
import type { ActivityStatus } from "./agent-row-display.js";
import type { RunView } from "./run-view.js";
import { buildRunView } from "./run-view.js";

/** The terminal subset of {@link ActivityStatus} — the only values markCompleted/markFailed accept. */
export type TerminalStatus = Extract<
  ActivityStatus,
  "done" | "error" | "failed" | "skipped" | "timedout" | "budget" | "aborted"
>;

export interface InFlightSubagent {
  /** The toolCallId (unique per dispatch). For a workflow run, the prefixed
   *  workflow runId ("wf:<runId>") — distinct from any subagent toolCallId. */
  id: string;
  agent?: string;
  /** The requested model/tier/capability slot. Omitted for a workflow run, which
   *  aggregates agents across models and therefore has no single model — the
   *  context box renders a workflow-specific header; /subagents omits the model
   *  segment for entries without one (decision 03 = b2). */
  model?: string;
  /** Concrete provider/id once the child resolves its model (onModelResolved).
   * Undefined until resolution — the call line shows tier/model-request until then. */
  resolvedModel?: string;
  /** The originally-requested model spec (before resolution). Set when the
   *  resolution fell back to a different model (markFallback). */
  requestedModel?: string;
  /** True when the model resolution fell back to a different model than requested. */
  fellBack?: boolean;
  /** The batch tool's own toolCallId, set on every child of a `subagents` batch so
   *  the /subagents viewer can group them under one header. Undefined for singular
   *  `subagent` dispatches (flat, ungrouped) and workflow agents. */
  batchId?: string;
  /** Lifecycle status (single vocabulary: ActivityStatus). Live runs are
   *  "running"/"queued"; terminal transitions (markCompleted/markFailed) stamp
   *  a TerminalStatus. Legacy callers passing the pre-unification literal
   *  "completed" are coerced to "done" by start(). */
  status: ActivityStatus;
  /** Wall-clock end time (epoch ms), stamped on the terminal transition
   *  (`markCompleted`). While a run is live, elapsed is computed as
   *  `now - startedAt`; once terminal it must freeze at
   *  `endedAt - startedAt` so a completed child's displayed elapsed never
   *  keeps growing while it lingers in the registry (k/N progress). */
  endedAt?: number;
  /** Render-surface axis (wayfinder: unified subagent-context box).
   *  `true` = this run is rendered INLINE in the current turn by the registering
   *  tool's own call/result line (Surface A): the singular `subagent` tool and the
   *  `subagents` batch tool set it. `false` (default) = detached/background (e.g.
   *  a background workflow run), shown ONLY by the above-editor context box so the
   *  two surfaces never duplicate. The box filters to `!foreground`; `/subagents`
   *  shows all regardless. `start()` defaults it to `false` when omitted. */
  foreground?: boolean;
  taskPreview: string;
  /** Work-intent preview — `workIntentPreview(task)` computed once at `start()`
   *  (strips a leading `Working dir:`/`Cwd:`/`Repo:` preamble line, single-lined,
   *  ≤60 chars). The docked context box feeds THIS (not `taskPreview`, which is
   *  already single-lined so its preamble can't be stripped) into
   *  `renderSubagentCall` so the header surfaces the actual work intent (ticket 04,
   *  finding 1 — #1101's strip was dead on the context box). `taskPreview` stays
   *  the viewer/persistence verbatim path. Optional: old/test entries fall back to
   *  `taskPreview` when absent. */
  workIntent?: string;
  startedAt: number;
  /** Latest compact history snapshot (for the live-output trace). */
  history?: AgentHistoryEntry[];
  /** Bound by renderCall so updateModel can force a call-line re-render mid-run. */
  invalidate?: () => void;
  /** Per-child abort lever — fires the child's AbortController so the /subagents
   *  viewer (x-key) can abort ONE running child without aborting the whole turn.
   *  Set by the tool at dispatch; fired by the registry's abort(id). */
  abort?: () => void;
}

/**
 * Process-local registry of running subagents. Process-local by design: a
 * subagent runs in-process (spawnSubagent → WorkflowAgent.run), so all live
 * runs are in this process. Completed runs persist in the session branch and
 * are reconstructed separately by the viewer.
 */
export class SubagentInFlightRegistry {
  private runs = new Map<string, InFlightSubagent>();

  start(run: Omit<InFlightSubagent, "status"> & { status?: ActivityStatus | "completed" }): void {
    // foreground defaults to `false` (background/detached) when the caller omits
    // it, so the above-editor context box picks the run up. Foreground tools
    // (`subagent`/`subagents`) set it explicitly to `true` to opt OUT of the box
    // (they render inline via Surface A). See subagent-context-widget.ts.
    // Legacy "completed" (pre-unification literal) coerces to "done".
    const status: ActivityStatus =
      run.status === undefined || run.status === "running"
        ? "running"
        : run.status === "completed"
          ? "done"
          : run.status;
    this.runs.set(run.id, { ...run, status, foreground: run.foreground ?? false });
  }

  update(id: string, history: AgentHistoryEntry[]): void {
    const r = this.runs.get(id);
    if (r) r.history = history;
  }

  /** @internal — Dispatch B removes; use view(). */
  get(id: string): InFlightSubagent | undefined {
    return this.runs.get(id);
  }

  /** Fresh per-tick projection of one run (never cache across render ticks). */
  view(id: string): RunView | undefined {
    const r = this.runs.get(id);
    return r ? buildRunView(r, Date.now()) : undefined;
  }

  /** Fresh per-tick projections of all runs; filters by foreground when present. */
  views(opts?: { foreground?: boolean }): RunView[] {
    const now = Date.now();
    return [...this.runs.values()]
      .filter((r) => opts?.foreground === undefined || r.foreground === opts.foreground)
      .map((r) => buildRunView(r, now));
  }

  /** Overwrite the task preview shown for a run (e.g. as the real task resolves). */
  updateTaskPreview(id: string, text: string): void {
    const r = this.runs.get(id);
    if (r) r.taskPreview = text;
  }

  /** Bind the harness invalidate for this run (called from the tool's renderCall). */
  bindInvalidate(id: string, invalidate: () => void): void {
    const r = this.runs.get(id);
    if (r) r.invalidate = invalidate;
  }

  /** Record the concrete resolved model and force a call-line re-render when an
   * invalidate was bound. No-op after end() (run gone) — mirrors update(). */
  updateModel(id: string, model: string): void {
    const r = this.runs.get(id);
    if (!r) return;
    r.resolvedModel = model;
    r.invalidate?.();
  }

  /** Mark a run as having fallen back to a different model than requested.
   *  Sets `requestedModel` + `fellBack` on the entry without touching
   *  `resolvedModel` (that is still set by `updateModel` when the actual
   *  model is known). No-op after end(). */
  markFallback(id: string, requestedModel: string): void {
    const r = this.runs.get(id);
    if (!r) return;
    r.requestedModel = requestedModel;
    r.fellBack = true;
    r.invalidate?.();
  }

  end(id: string): void {
    this.runs.delete(id);
  }

  /** Mark a run terminal WITHOUT removing it (so the header can show k/N
   *  and the frozen trace stays followable). Stamps `status` + `endedAt` so
   *  every elapsed-time renderer freezes the run at its real end instead of
   *  ticking forever while the entry lingers pre-eviction. Per-child eviction
   *  happens via endBatch. */
  markCompleted(id: string, status: TerminalStatus = "done"): void {
    const r = this.runs.get(id);
    if (r) {
      r.status = status;
      r.endedAt = Date.now();
    }
  }

  /** Terminal transition for a failed run — identical stamping to markCompleted
   *  (status + endedAt), defaulting to "failed". */
  markFailed(id: string, status: TerminalStatus = "failed"): void {
    const r = this.runs.get(id);
    if (r) {
      r.status = status;
      r.endedAt = Date.now();
    }
  }

  /** Evict every child of one batch (called when the batch tool's execute() returns). */
  endBatch(batchId: string): void {
    for (const [id, r] of this.runs) {
      if (r.batchId === batchId) this.runs.delete(id);
    }
  }

  /** Fire one running child's abort lever (per-child mid-flight abort). Distinct
   *  from end() — the entry stays in the registry (the tool deregisters it on
   *  spawn's return). No-op for an unknown / already-ended id, mirroring
   *  update()/updateModel(): a user abort that races with natural completion
   *  must never throw. */
  abort(id: string): void {
    this.runs.get(id)?.abort?.();
  }

  /** @deprecated use views(). */
  list(): InFlightSubagent[] {
    return [...this.runs.values()];
  }
}

let _registrySingleton: SubagentInFlightRegistry | undefined;
/**
 * Process-wide singleton so the `subagent` tool (subagent extension) and the
 * `/subagents` viewer/command (workflow extension) share ONE registry across
 * extensions. Importers MUST use the package barrel (`@repo/pi-agent-ext-subagent`)
 * so both extensions resolve the same module instance.
 */
export function getSubagentInFlightRegistry(): SubagentInFlightRegistry {
  // biome-ignore lint/suspicious/noAssignInExpressions: lazy-init singleton idiom
  return (_registrySingleton ??= new SubagentInFlightRegistry());
}
