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
  taskPreview: string;
  startedAt: number;
  /** Latest compact history snapshot (for the live-output trace). */
  history?: AgentHistoryEntry[];
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

  end(id: string): void {
    this.runs.delete(id);
  }

  list(): InFlightSubagent[] {
    return [...this.runs.values()];
  }
}
