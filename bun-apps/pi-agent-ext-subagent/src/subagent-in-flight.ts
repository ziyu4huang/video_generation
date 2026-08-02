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

export interface InFlightSubagent {
  /** The toolCallId (unique per dispatch). */
  id: string;
  agent?: string;
  model: string;
  /** Concrete provider/id once the child resolves its model (onModelResolved).
   * Undefined until resolution — the call line shows tier/model-request until then. */
  resolvedModel?: string;
  /** The batch tool's own toolCallId, set on every child of a `subagents` batch so
   *  the /subagents viewer can group them under one header. Undefined for singular
   *  `subagent` dispatches (flat, ungrouped) and workflow agents. */
  batchId?: string;
  /** Lifecycle status for batch-tool children. The batch tool sets "completed" on
   *  finish (kept in the registry for k/N progress + frozen-trace follow) and
   *  evicts the whole batch on its return. Undefined (= "running") for singular
   *  `subagent` dispatches, workflow agents, and obsidian — they `end()` per-child
   *  as before and never appear "completed". */
  status?: "running" | "completed";
  taskPreview: string;
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

  start(run: InFlightSubagent): void {
    this.runs.set(run.id, run);
  }

  update(id: string, history: AgentHistoryEntry[]): void {
    const r = this.runs.get(id);
    if (r) r.history = history;
  }

  get(id: string): InFlightSubagent | undefined {
    return this.runs.get(id);
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

  end(id: string): void {
    this.runs.delete(id);
  }

  /** Mark a batch child finished without removing it (so the header can show k/N
   *  and the frozen trace stays followable). Per-child eviction happens via endBatch. */
  markCompleted(id: string): void {
    const r = this.runs.get(id);
    if (r) r.status = "completed";
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

  list(): InFlightSubagent[] {
    return [...this.runs.values()];
  }
}

let _registrySingleton: SubagentInFlightRegistry | undefined;
/**
 * Process-wide singleton so the `subagent` tool (subagent extension) and the
 * `/subagents` viewer/command (workflow extension) share ONE registry across
 * extensions. Importers MUST use the src subpath (`@repo/pi-agent-ext-subagent/src/...`)
 * so both extensions resolve the same module instance.
 */
export function getSubagentInFlightRegistry(): SubagentInFlightRegistry {
  // biome-ignore lint/suspicious/noAssignInExpressions: lazy-init singleton idiom
  return (_registrySingleton ??= new SubagentInFlightRegistry());
}
