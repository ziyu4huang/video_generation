/**
 * Immutable, per-tick projection of one run's derived presentation state.
 *
 * Built ONLY by `buildRunView`; renderers consume `RunView` and never read
 * raw run fields. Contract: per-tick ephemeral — never cache across render
 * ticks; call registry.view(s)() fresh each render so live elapsed and
 * history-derived fields are always current.
 */
import type { AgentHistoryEntry } from "./agent-history.js";
import type { ActivityStatus } from "./agent-row-display.js";
import { ellipsizeToWidth } from "./render-width.js";
import type { InFlightSubagent } from "./subagent-in-flight.js";

/** Internal alias for the raw registry record (NOT part of the barrel — Dispatch B removes the raw surface). */
export type RunRecord = InFlightSubagent;

export interface RunView {
  readonly id: string;
  readonly batchId?: string;
  readonly foreground: boolean;
  /** True once the run was detached to background (Task 05). */
  readonly detached?: boolean;
  /** True when dispatched in the background from birth (see InFlightSubagent.background). */
  readonly background?: boolean;
  /** The full raw task prompt, when the registering tool supplied one (Task 05
   *  detach manifests). Absent on legacy entries — use taskPreview then. */
  readonly task?: string;
  readonly status: ActivityStatus;
  /** agent ?? "general-purpose" */
  readonly actor: string;
  /** fallback-aware, plain text (no theme) */
  readonly modelSeg?: string;
  /** terminal: endedAt - startedAt (frozen); live: now - startedAt */
  readonly elapsedMs: number;
  readonly elapsedFrozen: boolean;
  /** history.filter(kind === "toolCall").length */
  readonly toolCallCount: number;
  /** last toolCall summary ?? taskPreview */
  readonly latestAction?: string;
  /** taskPreview passthrough — the header task when workIntent is absent. */
  readonly taskPreview: string;
  readonly workIntent?: string;
  readonly badgeText?: string;
  /** Which family owns the run — workflow rows (wf:) render the `wf` badge
   *  and omit the model segment (they aggregate across models). */
  readonly runKind?: "subagent" | "workflow";
  /** abort lever present */
  readonly abortable: boolean;
  readonly history: readonly AgentHistoryEntry[];
  readonly startedAt: number;
  /** Accrued child cost (USD); frozen at terminal (mirrors elapsedFrozen). */
  readonly costUsd: number;
  /** Accrued child input tokens; frozen at terminal. */
  readonly tokensIn: number;
  /** Accrued child output tokens; frozen at terminal. */
  readonly tokensOut: number;
}

/** Short, compact model segment: drop provider prefix, cap runaway ids (by terminal columns). */
function shortModelSeg(model: string): string {
  const slash = model.lastIndexOf("/");
  const seg = slash >= 0 ? model.slice(slash + 1) : model;
  return ellipsizeToWidth(seg, 24);
}

function modelSegFor(r: RunRecord): string | undefined {
  if (r.fellBack && r.requestedModel) {
    // Fallback marker: resolved←requested (mirrors the subagents-tool segment spirit).
    const resolved = r.resolvedModel ? shortModelSeg(r.resolvedModel) : "?";
    return `${resolved}→${shortModelSeg(r.requestedModel)}`;
  }
  // self-arc-10 t02 honesty: a run with no resolved model and no requested
  // slot (workflow aggregates, or a subagent dispatched untagged while
  // getMainModel is unwired) has NOTHING to say about a model — the segment
  // is omitted rather than rendering the literal "default" (same call the
  // subagent call-line made in self-arc-9 t01).
  const m = r.resolvedModel ?? r.model;
  return m ? shortModelSeg(m) : undefined;
}

/** Best-effort one-line label for a history entry (name/title/whatever it exposes). */
function historyEntryLabel(entry: AgentHistoryEntry): string | undefined {
  const e = entry as unknown as Record<string, unknown>;
  for (const key of ["title", "name", "label", "summary", "text"]) {
    const v = e[key];
    if (typeof v === "string" && v.length > 0) return v;
    if (v && typeof v === "object") {
      const inner = (v as Record<string, unknown>).name;
      if (typeof inner === "string" && inner.length > 0) return inner;
    }
  }
  return undefined;
}

function kindOf(entry: AgentHistoryEntry): unknown {
  return (entry as unknown as Record<string, unknown>).kind;
}

/** Single home of the terminal predicate for the unified ActivityStatus vocabulary. */
/** Terminal = the run will never run again. "paused" is deliberately
 *  NON-terminal (self-arc-10 t01): a paused workflow resumes, so its elapsed
 *  must keep counting from startedAt (never freeze) and usage must keep
 *  accruing — a naive "not running/queued ⇒ terminal" predicate would freeze
 *  both the moment a workflow parks. */
export function isTerminalStatus(status: ActivityStatus | null | undefined): boolean {
  // defensive: records constructed before the status field became required may omit it
  const s = status ?? "running";
  return s !== "running" && s !== "queued" && s !== "paused";
}

/** Pure projection — takes the raw record + now; never reads the clock itself. */
export function buildRunView(r: RunRecord, now: number): RunView {
  const status: ActivityStatus = r.status;
  const endedAt = r.endedAt;
  const terminal = isTerminalStatus(status);
  const elapsedFrozen = terminal && typeof endedAt === "number";
  const elapsedMs = typeof endedAt === "number" ? endedAt - r.startedAt : now - r.startedAt;
  const history = r.history ?? [];
  const toolCallCount = history.filter((e) => kindOf(e) === "toolCall").length;
  let latestAction: string | undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry && kindOf(entry) === "toolCall") {
      latestAction = historyEntryLabel(entry);
      break;
    }
  }
  latestAction ??= r.taskPreview || undefined;
  return {
    id: r.id,
    batchId: r.batchId,
    foreground: r.foreground ?? false,
    detached: r.detached,
    background: r.background,
    task: r.task,
    status,
    actor: r.agent ?? "general-purpose",
    modelSeg: modelSegFor(r),
    elapsedMs,
    elapsedFrozen,
    toolCallCount,
    latestAction,
    taskPreview: r.taskPreview,
    workIntent: r.workIntent,
    badgeText: r.runKind === "workflow" ? "wf" : r.fellBack ? "fallback" : r.background ? "bg" : undefined,
    runKind: r.runKind ?? (r.id.startsWith("wf:") ? "workflow" : undefined),
    abortable: typeof r.abort === "function",
    history,
    startedAt: r.startedAt,
    costUsd: r.usageAccrued?.costUsd ?? 0,
    tokensIn: r.usageAccrued?.tokensIn ?? 0,
    tokensOut: r.usageAccrued?.tokensOut ?? 0,
  };
}
