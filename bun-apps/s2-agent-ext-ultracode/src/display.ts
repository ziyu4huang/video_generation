import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { AgentHistoryEntry, ThemeLike, WorkflowErrorCode } from "@repo/s2-agent-core-runtime";
import { activityGlyph, fmtCost, NO_THEME, shorten } from "@repo/s2-agent-core-runtime";
import type { RunStatus } from "./run-persistence.js";
import type { WorkflowMeta } from "./workflow.js";

export type WorkflowAgentStatus = "queued" | "running" | "done" | "error" | "skipped";

export interface WorkflowAgentSnapshot {
  id: number;
  /** Deterministic call index (the journal key) — stable identity for start↔end correlation. */
  callIndex?: number;
  label: string;
  phase?: string;
  prompt: string;
  status: WorkflowAgentStatus;
  resultPreview?: string;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  history?: AgentHistoryEntry[];
  /** Tokens used by this agent. */
  tokens?: number;
  /** The model this agent ran on (provider/id), when known. */
  model?: string;
  /** Wall-clock ms timestamp when the agent started (for live elapsed). */
  startedAt?: number;
}

export interface WorkflowSnapshot {
  name: string;
  description?: string;
  phases: string[];
  currentPhase?: string;
  logs: string[];
  agents: WorkflowAgentSnapshot[];
  agentCount: number;
  runningCount: number;
  doneCount: number;
  errorCount: number;
  durationMs?: number;
  result?: unknown;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  runId?: string;
}

export interface WorkflowDisplay {
  update(snapshot: WorkflowSnapshot): void;
  complete(snapshot: WorkflowSnapshot): void;
  clear(): void;
}

export interface WorkflowDisplayOptions {
  key?: string;
  placement?: "aboveEditor" | "belowEditor";
  maxAgents?: number;
  showStatus?: boolean;
  showResultPreviews?: boolean;
}

export function createWorkflowSnapshot(meta: WorkflowMeta): WorkflowSnapshot {
  return {
    name: meta.name,
    description: meta.description,
    phases: meta.phases?.map((phase) => phase.title) ?? [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
  };
}

export interface AgentCounts {
  total: number;
  running: number;
  done: number;
  error: number;
  skipped: number;
  /** done + error + skipped — statuses that will not change again. */
  finished: number;
}

/**
 * The single agent-status count derivation (snapshot-row-single-source,
 * ticket 02). Every presentation site that needs done/running/error/skipped/
 * finished counts calls this — no per-site `agents.filter(...)` copies. Accepts
 * anything with a `status` field, so both WorkflowAgentSnapshot[] (live) and
 * PersistedAgentState[] (persisted) work.
 */
export function agentCounts(agents: Array<Pick<WorkflowAgentSnapshot, "status">>): AgentCounts {
  let running = 0;
  let done = 0;
  let error = 0;
  let skipped = 0;
  for (const a of agents) {
    if (a.status === "running") running++;
    else if (a.status === "done") done++;
    else if (a.status === "error") error++;
    else if (a.status === "skipped") skipped++;
  }
  return { total: agents.length, running, done, error, skipped, finished: done + error + skipped };
}

export function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const counts = agentCounts(snapshot.agents);
  return {
    ...snapshot,
    agentCount: counts.total,
    runningCount: counts.running,
    doneCount: counts.done,
    errorCount: counts.error,
  };
}

export function createWidgetWorkflowDisplay(
  ctx: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions = {},
): WorkflowDisplay {
  const key = options.key ?? "workflow";
  const placement = options.placement ?? "belowEditor";
  const showStatus = options.showStatus ?? false;

  // Mutable state captured by the component closure so re-renders
  // always read the latest snapshot even though the factory ran once.
  let snapshot: WorkflowSnapshot | undefined;
  let completed = false;

  // Store the factory so update()/complete() can re-register it to trigger re-render.
  const widgetFactory = (_tui: unknown, theme: Theme) => ({
    render: () => (snapshot ? renderWorkflowLines(snapshot, options, theme) : []),
    invalidate: () => {},
  });

  if (ctx.hasUI) {
    ctx.ui.setWidget(key, widgetFactory, { placement });
  }

  return {
    update(s) {
      snapshot = s;
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, statusLine(s, completed));
      ctx.ui.setWidget(key, widgetFactory, { placement });
    },
    complete(s) {
      snapshot = s;
      completed = true;
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, statusLine(s, true));
      ctx.ui.setWidget(key, widgetFactory, { placement });
    },
    clear() {
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, undefined);
      ctx.ui.setWidget(key, undefined);
    },
  };
}

export function createToolUpdateWorkflowDisplay(
  onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined,
  ctx?: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions & { streamToolUpdates?: boolean } = {},
): WorkflowDisplay {
  const widget = ctx ? createWidgetWorkflowDisplay(ctx, options) : undefined;
  const streamToolUpdates = options.streamToolUpdates ?? !ctx?.hasUI;

  const emit = (snapshot: WorkflowSnapshot, completed = false) => {
    if (streamToolUpdates) {
      onUpdate?.({
        content: [{ type: "text", text: renderWorkflowText(snapshot, completed) }],
        details: snapshot,
      });
    }
    if (completed) widget?.complete(snapshot);
    else widget?.update(snapshot);
  };

  return {
    update(snapshot) {
      emit(snapshot, false);
    },
    complete(snapshot) {
      emit(snapshot, true);
    },
    clear() {
      widget?.clear();
    },
  };
}

/** Compact human duration: 12s / 1m23s / 1h05m. */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** Trailing per-agent bracket: [model · elapsed|tokens]. Running shows live
 * elapsed (needs startedAt); done shows the token count. Model is the full
 * provider/id spec when known. */
function agentBracket(agent: WorkflowAgentSnapshot, theme: ThemeLike): string {
  const meta =
    agent.status === "running" && typeof agent.startedAt === "number"
      ? fmtDuration(Date.now() - agent.startedAt)
      : agent.tokens
        ? `${agent.tokens.toLocaleString()} tok`
        : "";
  const parts = [agent.model, meta].filter(Boolean);
  return parts.length ? theme.fg("dim", ` [${parts.join(" · ")}]`) : "";
}

export function renderWorkflowLines(
  snapshot: WorkflowSnapshot,
  options: WorkflowDisplayOptions = {},
  theme: ThemeLike = NO_THEME,
): string[] {
  const maxAgents = options.maxAgents ?? 8;
  const showResultPreviews = options.showResultPreviews ?? false;
  const state =
    snapshot.errorCount > 0
      ? `, ${snapshot.errorCount} errors`
      : snapshot.runningCount > 0
        ? `, ${snapshot.runningCount} running`
        : "";
  // Build header with token info (and cost when the provider reports it)
  const usage = snapshot.tokenUsage;
  const costInfo = usage?.cost ? ` · $${fmtCost(usage.cost)}` : "";
  const tokenInfo = usage ? ` · ${usage.total.toLocaleString()} tokens${costInfo}` : "";
  const lines = [
    `${theme.bold(`◆ Workflow: ${snapshot.name}`)} (${snapshot.doneCount}/${snapshot.agentCount} done${state}${tokenInfo})`,
  ];

  const phaseNames = snapshot.phases.length
    ? snapshot.phases
    : unique(snapshot.agents.map((agent) => agent.phase).filter(Boolean) as string[]);
  const rendered = new Set<WorkflowAgentSnapshot>();

  for (const phase of phaseNames) {
    const agents = snapshot.agents.filter((agent) => agent.phase === phase);
    for (const agent of agents) rendered.add(agent);
    const done = agents.filter((agent) => agent.status === "done").length;
    const running = agents.filter((agent) => agent.status === "running").length;
    const errors = agents.filter((agent) => agent.status === "error").length;
    const skipped = agents.filter((agent) => agent.status === "skipped").length;
    const complete = agents.length > 0 && done + errors + skipped === agents.length;
    const marker = running > 0 || (!complete && snapshot.currentPhase === phase) ? "▶" : complete ? "✓" : " ";
    lines.push(
      theme.fg("accent", `  ${marker} ${phase}`) +
        theme.fg(
          "dim",
          ` ${done}/${agents.length}${running ? ` · ${running} running` : ""}${errors ? ` · ${errors} errors` : ""}${skipped ? ` · ${skipped} skipped` : ""}`,
        ),
    );

    const visibleAgents = agents.slice(-maxAgents);
    for (const agent of visibleAgents) {
      const order = `[${agent.id}]`;
      const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
      lines.push(
        `    ${order} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${agentBracket(agent, theme)}${result}`,
      );
    }
    if (agents.length > visibleAgents.length)
      lines.push(theme.fg("dim", `    … ${agents.length - visibleAgents.length} earlier agents`));
  }

  const unphased = snapshot.agents.filter((agent) => !rendered.has(agent));
  if (unphased.length) {
    lines.push(theme.fg("accent", "  Unphased"));
    for (const agent of unphased.slice(-maxAgents)) {
      const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
      lines.push(
        `    [${agent.id}] ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${agentBracket(agent, theme)}${result}`,
      );
    }
  }

  return lines;
}

export function renderWorkflowText(snapshot: WorkflowSnapshot, completed = false): string {
  const header = completed ? "Workflow completed" : "Workflow running";
  return [header, ...renderWorkflowLines(snapshot)].join("\n");
}

function statusLine(snapshot: WorkflowSnapshot, completed: boolean): string {
  if (completed) return `workflow ✓ ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount}`;
  if (snapshot.runningCount > 0)
    return `workflow ${snapshot.name}: ${snapshot.runningCount} running, ${snapshot.doneCount}/${snapshot.agentCount} done`;
  return `workflow ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount} done`;
}

export function statusIcon(status: WorkflowAgentStatus): string {
  return activityGlyph(status).icon;
}

/** Run-level status glyphs. Exhaustive Record<RunStatus, string>: adding a
 * RunStatus value without a glyph is a compile error, and every lookup is
 * total — the silent `?? "?"` fallback of the old STATUS_ICON maps is gone
 * by construction (snapshot-row-single-source, ticket 04). Agent-status
 * glyphs stay with activityGlyph (core-runtime/agent-row-display.ts). */
const RUN_STATUS_GLYPHS: Record<RunStatus, string> = {
  pending: "·",
  running: "◆",
  paused: "⏸",
  completed: "✓",
  failed: "✗",
  aborted: "⊘",
};

export function runStatusGlyph(status: RunStatus): string {
  return RUN_STATUS_GLYPHS[status];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
