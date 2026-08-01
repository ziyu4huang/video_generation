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
  taskPreview: string;
  startedAt: number;
  /** Latest compact history snapshot (for the live-output trace). */
  history?: AgentHistoryEntry[];
  /** Bound by renderCall so updateModel can force a call-line re-render mid-run. */
  invalidate?: () => void;
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
