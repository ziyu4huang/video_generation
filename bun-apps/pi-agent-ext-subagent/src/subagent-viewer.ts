/**
 * `/subagents` viewer — three stateful view-modes:
 *  - `list`: a unified selectable list of Running (live, from the in-flight
 *    registry) + Completed (reconstructed from the session branch) runs.
 *  - `output`: a selected completed run's full output.
 *  - `follow`: attaches to one running subagent and live-streams its tool-call
 *    trace; on completion it freezes with the final status/usage.
 * `list`/`output` are reconstructed from the session branch (branching-safe);
 * `follow` reads the in-flight registry live and re-scans the branch once to
 * resolve the followed run's completion.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { type ActivityRow, fmtCost, renderActivityRow, shortModel } from "./agent-row-display.js";
import type { AgentHistoryEntry, AgentUsage, InFlightSubagent, SubagentToolDetails } from "./index.js";
import { formatHistoryLine, summarizeLatestAction } from "./index.js";
import { formatAbsoluteTime, formatRelativeTime } from "./time-format.js";

/** Tail-f window: how many recent trace lines the follow view shows. */
const FOLLOW_TRACE_LINES = 40;
/** Ticks the follow view waits for a completed run to appear in the branch before the `ended` fallback. */
const FOLLOW_FINALIZE_GRACE_TICKS = 5;
/** Completed-run cap shown by default (most-recent). Suspended by filter or show-all. */
const COMPLETED_CAP = 20;

export interface SubagentRun {
  /** 1-based ordinal among subagent runs on this branch. */
  index: number;
  /** The tool-call id (matches InFlightSubagent.id); used by live-follow to match a completed run. */
  toolCallId?: string;
  agent?: string;
  model: string;
  taskPreview: string;
  status: "done" | "failed" | "timedout" | "budget";
  elapsedMs: number;
  /** Wall-clock dispatch start, epoch ms (for timestamp display); absent on legacy branch entries. */
  startedAt?: number;
  /** Real token/cost usage, when reported. */
  usage?: AgentUsage;
  /** The full text the parent agent read (content[0].text). */
  output: string;
}

interface BranchMessage {
  role?: string;
  toolName?: string;
  toolCallId?: string;
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
      toolCallId: msg.toolCallId,
      agent: d?.agent,
      model: d?.model ?? "default",
      taskPreview: d?.taskPreview ?? "",
      status,
      elapsedMs: d?.elapsedMs ?? 0,
      startedAt: d?.startedAt,
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
  /** Live re-scan of the branch, used to resolve a followed run's completion (Task 4). */
  getRuns?: () => SubagentRun[];
  onClose: () => void;
}

/** Stateful list↔output↔follow viewer. `view` flips on enter/esc; no second UI mount. */
export class SubagentViewer {
  private runs: SubagentRun[];
  private getRunning?: () => InFlightSubagent[];
  private getRuns?: () => SubagentRun[];
  private view: "list" | "output" | "follow" = "list";
  private filter = "";
  private showAll = false;
  private selected = 0; // unified cursor over entries() (running first, then completed)
  private outputRun?: SubagentRun; // the completed run open in `output` (decoupled from the list cursor)
  private onClose: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private theme: Theme;
  // follow state
  private followedId?: string;
  private followedSnapshot?: {
    history: AgentHistoryEntry[];
    model: string;
    agent?: string;
    startedAt: number;
  };
  private followedFinal?: SubagentRun; // set by Task 4 on completion
  private followEnded = false;
  private finalizingTicks = 0;

  constructor(opts: ViewerOpts, theme: Theme) {
    this.runs = opts.runs;
    this.getRunning = opts.getRunning;
    this.getRuns = opts.getRuns;
    this.onClose = opts.onClose;
    this.theme = theme;
  }

  /** Flat selectable list: running entries first, then completed, with a divider rendered between.
   *  When `filter` is non-empty, both sections are narrowed to entries whose `agent`
   *  OR `taskPreview` contains the query (case-insensitive substring). */
  private entries(): Array<{ kind: "running"; ref: InFlightSubagent } | { kind: "completed"; ref: SubagentRun }> {
    const q = this.filter.trim().toLowerCase();
    const matches = (agent: string | undefined, preview: string): boolean =>
      !q || (agent ?? "").toLowerCase().includes(q) || preview.toLowerCase().includes(q);
    const running = (this.getRunning?.() ?? []).filter((r) => matches(r.agent, r.taskPreview));
    const allCompleted = this.runs.filter((r) => matches(r.agent, r.taskPreview));
    const capped = !q && !this.showAll ? allCompleted.slice(-COMPLETED_CAP) : allCompleted;
    return [
      ...running.map((ref) => ({ kind: "running" as const, ref })),
      ...capped.map((ref) => ({ kind: "completed" as const, ref })),
    ];
  }

  private enterFollow(id: string): void {
    this.followedId = id;
    this.followedSnapshot = undefined;
    this.followedFinal = undefined;
    this.followEnded = false;
    this.finalizingTicks = 0;
    this.view = "follow";
    this.invalidate();
  }

  private clearFollow(): void {
    this.followedId = undefined;
    this.followedSnapshot = undefined;
    this.followedFinal = undefined;
    this.followEnded = false;
    this.finalizingTicks = 0;
    this.filter = ""; // returning to the list from follow is unfiltered
    this.showAll = false; // re-entering the list starts capped
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.view === "list") {
        if (this.filter) {
          this.filter = ""; // first esc clears the filter, stays in list
          this.showAll = false; // re-entering the list starts capped
          this.selected = 0;
          this.invalidate();
        } else {
          this.onClose();
        }
      } else {
        this.view = "list";
        this.clearFollow();
        this.invalidate();
      }
      return;
    }
    if (this.view !== "list") return; // follow/output: no nav/filter keys in v1
    // filter input
    if ((data === "\x7f" || data === "\x08") && this.filter) {
      this.filter = this.filter.slice(0, -1);
      this.selected = 0;
      this.invalidate();
      return;
    }
    if (data === "a" && !this.filter && this.runs.length > COMPLETED_CAP) {
      this.showAll = !this.showAll;
      this.selected = 0;
      this.invalidate();
      return;
    }
    if (data.length === 1 && data >= " " && data <= "~") {
      this.filter += data;
      this.selected = 0;
      this.invalidate();
      return;
    }
    // nav (operates on the filtered entries)
    const entries = this.entries();
    if (this.selected > entries.length - 1) this.selected = Math.max(0, entries.length - 1);
    if (matchesKey(data, Key.up) && this.selected > 0) {
      this.selected -= 1;
      this.invalidate();
    } else if (matchesKey(data, Key.down) && this.selected < entries.length - 1) {
      this.selected += 1;
      this.invalidate();
    } else if (matchesKey(data, Key.enter) && entries.length > 0) {
      const e = entries[this.selected];
      if (!e) return;
      if (e.kind === "running") {
        this.enterFollow(e.ref.id);
      } else {
        this.outputRun = e.ref;
        this.view = "output";
        this.invalidate();
      }
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const th = this.theme;
    if (this.view === "list") this.cachedLines = this.renderList(width, th);
    else if (this.view === "follow") this.cachedLines = this.renderFollow(width, th);
    else this.cachedLines = this.renderOutput(width, th);
    this.cachedWidth = width;
    return this.cachedLines;
  }

  private renderList(width: number, th: Theme): string[] {
    const lines: string[] = [""];
    const entries = this.entries();
    if (this.selected > entries.length - 1) this.selected = Math.max(0, entries.length - 1);

    const running = entries.filter((e) => e.kind === "running") as Array<{ kind: "running"; ref: InFlightSubagent }>;
    if (running.length > 0) {
      const runningTitle = th.fg("accent", th.bold(" Running "));
      lines.push(truncateToWidth(runningTitle + th.fg("borderMuted", "─".repeat(Math.max(0, width - 9))), width));
      for (const e of running) {
        const r = e.ref;
        const cur = entries.indexOf(e) === this.selected;
        const toolCalls = r.history?.filter((h) => h.kind === "toolCall").length ?? 0;
        const row: ActivityRow = {
          status: "running",
          actor: r.agent ?? "general-purpose",
          model: r.resolvedModel ?? r.model,
          elapsedMs: Date.now() - r.startedAt,
          toolCalls,
          latestAction: summarizeLatestAction(r.history) ?? truncateToWidth(r.taskPreview, 40),
        };
        const head = renderActivityRow(row, th);
        lines.push(truncateToWidth(` ${cur ? th.bg("selectedBg", `▶ ${head}`) : `  ${head}`}`, width));
      }
      lines.push("");
    }

    const title = th.fg("accent", th.bold(" Subagent runs "));
    lines.push(truncateToWidth(title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 15))), width));
    lines.push("");
    const completed = entries.filter((e) => e.kind === "completed") as Array<{ kind: "completed"; ref: SubagentRun }>;
    if (completed.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "No subagent runs on this branch.")}`, width));
    } else {
      for (const e of completed) {
        const r = e.ref;
        const cur = entries.indexOf(e) === this.selected;
        const row: ActivityRow = {
          status: r.status,
          actor: r.agent ?? "general-purpose",
          badge: `#${r.index}`,
          model: shortModel(r.model),
          elapsedMs: r.elapsedMs,
          cost: r.usage?.cost,
          // latestAction is absent for completed → detail (taskPreview) shows as the tail
          detail: r.taskPreview
            ? `${r.startedAt ? `${formatRelativeTime(r.startedAt)} — ` : ""}${r.taskPreview}`
            : r.startedAt
              ? formatRelativeTime(r.startedAt)
              : undefined,
        };
        const head = renderActivityRow(row, th, 50);
        lines.push(truncateToWidth(` ${cur ? th.bg("selectedBg", `▶ ${head}`) : `  ${head}`}`, width));
      }
    }
    const totalCompleted = this.runs.length;
    const showing = completed.length;
    if (!this.filter && !this.showAll && totalCompleted > COMPLETED_CAP) {
      lines.push(truncateToWidth(`  ${th.fg("dim", `showing ${showing} of ${totalCompleted} • press 'a' to show all`)}`, width));
    }
    lines.push("");
    if (this.filter) {
      const n = entries.length;
      lines.push(truncateToWidth(`  ${th.fg("accent", `filter:`)} "${this.filter}" — ${n} match${n === 1 ? "" : "es"} • esc clear`, width));
    } else {
      lines.push(truncateToWidth(`  ${th.fg("dim", "↑↓ select • enter view/follow • esc close")}`, width));
    }
    lines.push("");
    return lines;
  }

  private renderOutput(width: number, th: Theme): string[] {
    const r = this.outputRun;
    if (!r) return [""];
    const lines: string[] = [""];
    const usageStr = r.usage && r.usage.total > 0 ? ` • $${fmtCost(r.usage.cost)} • ${r.usage.total} tok` : "";
    const absTime = r.startedAt ? ` • ${formatAbsoluteTime(r.startedAt)}` : "";
    lines.push(
      truncateToWidth(
        `  ${th.fg("accent", `#${r.index}`)} ${th.fg("muted", r.agent ?? "general-purpose")} ▸ ${r.model} • ${r.status} • ${(r.elapsedMs / 1000).toFixed(1)}s${absTime}${usageStr}`,
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

  private renderFollow(width: number, th: Theme): string[] {
    const lines: string[] = [""];
    const r = this.followedId ? this.getRunning?.().find((x) => x.id === this.followedId) : undefined;

    let status: string;
    let model: string;
    let elapsedMs: number;
    let usageStr = "";
    let agent: string | undefined;

    if (r) {
      // LIVE — refresh the snapshot from the registry entry each tick.
      this.followedSnapshot = {
        history: r.history ?? [],
        model: r.resolvedModel ?? r.model,
        agent: r.agent,
        startedAt: r.startedAt,
      };
      this.finalizingTicks = 0;
      status = "running";
      model = this.followedSnapshot.model;
      elapsedMs = Date.now() - r.startedAt;
      agent = r.agent;
    } else {
      // ABSENT — resolve completion. Task 4 fills the real freeze via getRuns;
      // until then (or past grace) show finalizing → ended.
      this.resolveCompletion();
      if (this.followedFinal) {
        const f = this.followedFinal;
        status = f.status;
        model = f.model;
        elapsedMs = f.elapsedMs;
        agent = f.agent;
        const u = f.usage;
        usageStr = u && u.total > 0 ? ` · $${fmtCost(u.cost)} · ${u.total} tok` : "";
      } else {
        status = this.followEnded ? "ended" : "finalizing";
        model = this.followedSnapshot?.model ?? "default";
        elapsedMs = this.followedSnapshot ? Date.now() - this.followedSnapshot.startedAt : 0;
        agent = this.followedSnapshot?.agent;
      }
    }

    const agentLabel = agent ?? "general-purpose";
    const head = `${followGlyph(status, th)} ${th.fg("accent", agentLabel)} ▸ ${th.fg("muted", model)} • ${th.fg("muted", status)} • ${(elapsedMs / 1000).toFixed(1)}s${usageStr}`;
    lines.push(truncateToWidth(`  ${head}`, width));
    lines.push(truncateToWidth(th.fg("borderMuted", "─".repeat(Math.max(0, width))), width));

    const trace = (this.followedSnapshot?.history ?? []).slice(-FOLLOW_TRACE_LINES).map(formatHistoryLine);
    if (trace.length === 0) trace.push("…");
    for (const ln of trace) {
      lines.push(truncateToWidth(`  ${th.fg("toolOutput", ln)}`, width));
    }
    lines.push("");
    const hint = status === "finalizing" ? "finalizing… " : "";
    lines.push(truncateToWidth(`  ${hint}${th.fg("dim", "esc back to list")}`, width));
    lines.push("");
    return lines;
  }

  /**
   * Resolve a followed run's completion once it leaves the registry: re-scan the
   * branch (live `getRuns`) and match by `toolCallId`. Within the grace window
   * the view shows `finalizing…`; past grace it falls back to a neutral `ended`
   * banner. Best-effort: a throwing `getRuns` is swallowed so the view never
   * crashes. Idempotent once `followedFinal`/`followEnded` is set.
   */
  private resolveCompletion(): void {
    if (this.followedFinal || this.followEnded) return;
    try {
      const final = this.getRuns?.().find((x) => x.toolCallId === this.followedId);
      if (final) {
        this.followedFinal = final;
        return;
      }
    } catch {
      // best-effort — fall through to the finalize/ended path
    }
    this.finalizingTicks += 1;
    if (this.finalizingTicks > FOLLOW_FINALIZE_GRACE_TICKS) this.followEnded = true;
  }

  /**
   * True when the current view shows live (changing) data worth a periodic
   * re-render for. Used by the `/subagents` timer to avoid re-rendering a
   * static completed-runs list or a static `output` view every second — the
   * cause of the replacement-UI flicker on the "show all subagents" list.
   */
  hasLiveContent(): boolean {
    if (this.view === "follow") return true;
    if (this.view === "list") return (this.getRunning?.() ?? []).length > 0;
    return false; // "output" view is static
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

/** Header glyph+color for a follow-view status (covers the statuses follow can show). */
function followGlyph(status: string, th: Theme): string {
  switch (status) {
    case "running":
      return th.fg("warning", "●");
    case "done":
      return th.fg("success", "✓");
    case "failed":
      return th.fg("error", "✗");
    case "timedout":
      return th.fg("warning", "⏱");
    case "budget":
      return th.fg("warning", "⛔");
    case "ended":
      return th.fg("dim", "–");
    default:
      return th.fg("dim", "…"); // finalizing
  }
}
