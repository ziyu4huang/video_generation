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
import type { InFlightSubagent } from "./subagent-in-flight.js";

/** Internal alias for the raw registry record (NOT part of the barrel — Dispatch B removes the raw surface). */
export type RunRecord = InFlightSubagent;

export interface RunView {
  readonly id: string;
  readonly batchId?: string;
  readonly foreground: boolean;
  readonly status: ActivityStatus;
  /** agent ?? "general-purpose" */
  readonly actor: string;
  /** fallback-aware, plain text (no theme) */
  readonly modelSeg: string;
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
  /** abort lever present */
  readonly abortable: boolean;
  readonly history: readonly AgentHistoryEntry[];
  readonly startedAt: number;
}

/** Short, compact model segment: drop provider prefix, cap runaway ids. */
function shortModelSeg(model: string): string {
  const slash = model.lastIndexOf("/");
  const seg = slash >= 0 ? model.slice(slash + 1) : model;
  return seg.length > 24 ? `${seg.slice(0, 23)}…` : seg;
}

function modelSegFor(r: RunRecord): string {
  if (r.fellBack && r.requestedModel) {
    // Fallback marker: resolved←requested (mirrors the subagents-tool segment spirit).
    const resolved = r.resolvedModel ? shortModelSeg(r.resolvedModel) : "?";
    return `${resolved}→${shortModelSeg(r.requestedModel)}`;
  }
  return shortModelSeg(r.resolvedModel ?? r.model ?? "default");
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
export function isTerminalStatus(status: ActivityStatus | null | undefined): boolean {
  // defensive: records constructed before the status field became required may omit it
  const s = status ?? "running";
  return s !== "running" && s !== "queued";
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
    status,
    actor: r.agent ?? "general-purpose",
    modelSeg: modelSegFor(r),
    elapsedMs,
    elapsedFrozen,
    toolCallCount,
    latestAction,
    taskPreview: r.taskPreview,
    workIntent: r.workIntent,
    badgeText: r.fellBack ? "fallback" : undefined,
    abortable: typeof r.abort === "function",
    history,
    startedAt: r.startedAt,
  };
}
