/**
 * `/subagents` history viewer. Reconstructs past `subagent` tool runs from the
 * session branch (exactly like the upstream `todo` extension's `/todos`) and
 * renders a stateful list↔output component. No live streaming — runs are the
 * COMPLETED tool results stored in the session (branching-safe by construction).
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentUsage } from "./agent.js";
import { summarizeLatestAction } from "./agent-history.js";
import { type ActivityRow, renderActivityRow } from "./display.js";
import type { InFlightSubagent } from "./subagent-in-flight.js";
import type { SubagentToolDetails } from "./subagent-tool.js";

export interface SubagentRun {
  /** 1-based ordinal among subagent runs on this branch. */
  index: number;
  agent?: string;
  model: string;
  taskPreview: string;
  status: "done" | "failed" | "timedout" | "budget";
  elapsedMs: number;
  /** Real token/cost usage, when reported. */
  usage?: AgentUsage;
  /** The full text the parent agent read (content[0].text). */
  output: string;
}

interface BranchMessage {
  role?: string;
  toolName?: string;
  content?: Array<{ type: string; text?: string }>;
  details?: Partial<SubagentToolDetails>;
}
interface BranchEntry {
  type: string;
  message?: BranchMessage;
}

/** Scan a session branch and collect subagent tool results in order. */
export function reconstructSubagentRuns(branch: Iterable<BranchEntry>): SubagentRun[] {
  const runs: SubagentRun[] = [];
  let i = 0;
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "toolResult" || msg.toolName !== "subagent") continue;
    i += 1;
    const d = msg.details;
    const status: SubagentRun["status"] = d?.status ?? (d && d.exitCode === 0 ? "done" : "failed");
    runs.push({
      index: i,
      agent: d?.agent,
      model: d?.model ?? "default",
      taskPreview: d?.taskPreview ?? "",
      status,
      elapsedMs: d?.elapsedMs ?? 0,
      usage: d?.usage,
      output: msg.content?.find((c) => c.type === "text")?.text ?? "",
    });
  }
  return runs;
}

interface ViewerOpts {
  runs: SubagentRun[];
  /** Live in-flight runs (read each render so elapsed stays fresh). */
  getRunning?: () => InFlightSubagent[];
  onClose: () => void;
}

/** Stateful list↔output viewer. `view` flips on enter/esc; no second UI mount. */
export class SubagentViewer {
  private runs: SubagentRun[];
  private getRunning?: () => InFlightSubagent[];
  private view: "list" | "output" = "list";
  private selected = 0;
  private onClose: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private theme: Theme;

  constructor(opts: ViewerOpts, theme: Theme) {
    this.runs = opts.runs;
    this.getRunning = opts.getRunning;
    this.onClose = opts.onClose;
    this.theme = theme;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.view === "output") {
        this.view = "list";
        this.invalidate();
      } else {
        this.onClose();
      }
      return;
    }
    if (this.view === "list") {
      if (matchesKey(data, Key.up) && this.selected > 0) {
        this.selected -= 1;
        this.invalidate();
      } else if (matchesKey(data, Key.down) && this.selected < this.runs.length - 1) {
        this.selected += 1;
        this.invalidate();
      } else if (matchesKey(data, Key.enter) && this.runs.length > 0) {
        this.view = "output";
        this.invalidate();
      }
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const th = this.theme;
    if (this.view === "list") {
      this.cachedLines = this.renderList(width, th);
    } else {
      this.cachedLines = this.renderOutput(width, th);
    }
    this.cachedWidth = width;
    return this.cachedLines;
  }

  private renderList(width: number, th: Theme): string[] {
    const lines: string[] = [""];
    // Running section — live in-flight subagents (read fresh each render so a
    // 1s invalidate timer keeps elapsed counting up). Closes the gap that
    // running subagents were invisible in /subagents until they finished.
    const running = this.getRunning?.() ?? [];
    if (running.length > 0) {
      const runningTitle = th.fg("accent", th.bold(" Running "));
      lines.push(truncateToWidth(runningTitle + th.fg("borderMuted", "─".repeat(Math.max(0, width - 9))), width));
      for (const r of running) {
        const toolCalls = r.history?.filter((h) => h.kind === "toolCall").length ?? 0;
        const row: ActivityRow = {
          status: "running",
          actor: r.agent ?? "general-purpose",
          model: r.model,
          elapsedMs: Date.now() - r.startedAt,
          toolCalls,
          latestAction: summarizeLatestAction(r.history) ?? truncateToWidth(r.taskPreview, 40),
        };
        lines.push(truncateToWidth(`  ${renderActivityRow(row, th)}`, width));
      }
      lines.push("");
    }
    const title = th.fg("accent", th.bold(" Subagent runs "));
    lines.push(truncateToWidth(title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 15))), width));
    lines.push("");
    if (this.runs.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "No subagent runs on this branch.")}`, width));
    } else {
      for (const r of this.runs) {
        const cur = r.index - 1 === this.selected;
        const row: ActivityRow = {
          status: r.status,
          actor: r.agent ?? "general-purpose",
          badge: `#${r.index}`,
          detail: r.taskPreview,
        };
        const head = renderActivityRow(row, th, 50);
        lines.push(truncateToWidth(` ${cur ? th.bg("selectedBg", "▶ " + head) : "  " + head}`, width));
      }
    }
    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "↑↓ select • enter view • esc close")}`, width));
    lines.push("");
    return lines;
  }

  private renderOutput(width: number, th: Theme): string[] {
    const r = this.runs[this.selected];
    if (!r) return [""];
    const lines: string[] = [""];
    const usageStr = r.usage && r.usage.total > 0 ? ` • $${r.usage.cost.toFixed(3)} • ${r.usage.total} tok` : "";
    lines.push(
      truncateToWidth(
        `  ${th.fg("accent", `#${r.index}`)} ${th.fg("muted", r.agent ?? "general-purpose")} ▸ ${r.model} • ${r.status} • ${(r.elapsedMs / 1000).toFixed(1)}s${usageStr}`,
        width,
      ),
    );
    lines.push(truncateToWidth(th.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
    for (const ln of r.output.split("\n")) {
      lines.push(truncateToWidth(`  ${th.fg("toolOutput", ln)}`, width));
    }
    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "esc back to list")}`, width));
    lines.push("");
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
