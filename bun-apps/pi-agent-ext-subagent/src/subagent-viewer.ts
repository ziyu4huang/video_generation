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
import type { AgentHistoryEntry, AgentUsage } from "@repo/pi-agent-ext-core-runtime";
import {
  type ActivityRow,
  type ActivityStatus,
  activityGlyph,
  fmtCost,
  fmtElapsed,
  isTerminalStatus,
  matchedCallArgsFor,
  type RunView,
  renderActivityRow,
  renderBadge,
  runHeader,
  shortModel,
  summarizeLatestAction,
} from "@repo/pi-agent-ext-core-runtime";
import { formatHistoryLine } from "./subagent-tool-render.js";
import type { SubagentToolDetails } from "./subagent-tool-schema.js";
import type { SubagentsToolDetails } from "./subagents-tool.js";
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
  /** Shared toolCallId of the parent `subagents` batch — present on expanded batch
   *  children (Completed-section grouping key); absent on singular `subagent` runs. */
  batchToolCallId?: string;
  agent?: string;
  model: string;
  taskPreview: string;
  status: "done" | "failed" | "timedout" | "budget" | "turns" | "aborted";
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

/** Scan a session branch and collect subagent tool results in order.
 *  Handles both the singular `subagent` tool (one entry per call) and the
 *  `subagents` batch tool — expands its positional result array into N child
 *  entries tagged with the batch's toolCallId (deficit 4b). Failed (null) batch
 *  slots carry no data and are skipped (their count is in the batch header). */
export function reconstructSubagentRuns(branch: Iterable<BranchEntry>): SubagentRun[] {
  const runs: SubagentRun[] = [];
  let i = 0;
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg?.role !== "toolResult") continue;

    if (msg.toolName === "subagents") {
      // Expand the batch's positional result array into N child runs (Option B').
      const d = msg.details as unknown as Partial<SubagentsToolDetails> | undefined;
      for (const slot of d?.results ?? []) {
        if (!slot) continue; // null === failed child (no data; count is in the batch header)
        i += 1;
        runs.push({
          index: i,
          batchToolCallId: msg.toolCallId,
          // Dispatch id of this child (`${batchToolCallId}:${slot.index}`) — the
          // SAME id the in-flight registry uses for a batch child, so the follow
          // view's resolveCompletion() (matched by toolCallId) resolves a batch
          // child's final status exactly like the singular path (P2: without it,
          // follow could never match and always fell to `ended`).
          toolCallId: `${msg.toolCallId ?? "batch"}:${slot.index}`,
          model: slot.model ?? "default",
          taskPreview: slot.task ?? "",
          status: slot.status,
          elapsedMs: slot.elapsedMs ?? 0,
          usage: "usage" in slot ? slot.usage : undefined,
          output: "output" in slot ? slot.output : "",
        });
      }
      continue;
    }

    if (msg.toolName !== "subagent") continue; // singular path — byte-identical to before
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
  /** Live in-flight runs as RunViews (fed by registry.views(); read each render so elapsed stays fresh). */
  getRunning?: () => RunView[];
  /** Live re-scan of the branch, used to resolve a followed run's completion (Task 4). */
  getRuns?: () => SubagentRun[];
  onClose: () => void;
  /** Per-child abort lever — fires when the user confirms an x-key abort on a
   *  Running entry. Wired to registry.abort(id) in subagents-command.ts. */
  onAbort?: (id: string) => void;
}

/** Stateful list↔output↔follow viewer. `view` flips on enter/esc; no second UI mount. */
export class SubagentViewer {
  private runs: SubagentRun[];
  private getRunning?: () => RunView[];
  private getRuns?: () => SubagentRun[];
  private view: "list" | "output" | "follow" = "list";
  private filter = "";
  private showAll = false;
  private selected = 0; // unified cursor over entries() (running first, then completed)
  /** Collapsed batch headers (by batchId). A collapsed batch's children are
   *  excluded from `entries()` entirely — hidden AND non-selectable. Per-batch
   *  so collapsing one batch never affects another. */
  private collapsedBatches = new Set<string>();
  private outputRun?: SubagentRun; // the completed run open in `output` (decoupled from the list cursor)
  private onClose: () => void;
  /** Per-child abort callback (Frontier A); fires on a confirmed x-key abort. */
  private onAbort?: (id: string) => void;
  /** When set, the viewer is mid-abort-confirm on this running id; only y/n/Esc resolve. */
  private confirmAbortId?: string;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private theme: Theme;
  // follow state
  private followedId?: string;
  private followedSnapshot?: {
    history: readonly AgentHistoryEntry[];
    model: string;
    agent?: string;
    /** Last live elapsed (RunView.elapsedMs) — frozen once the run leaves the registry. */
    elapsedMs: number;
  };
  private followedFinal?: SubagentRun; // set by Task 4 on completion
  private followEnded = false;
  private finalizingTicks = 0;

  constructor(opts: ViewerOpts, theme: Theme) {
    this.runs = opts.runs;
    this.getRunning = opts.getRunning;
    this.getRuns = opts.getRuns;
    this.onClose = opts.onClose;
    this.onAbort = opts.onAbort;
    this.theme = theme;
  }

  /** Selectable list. Running entries come first (grouped: one `batchHeader`
   *  entry per batch at its first child, then the child entries unless the
   *  batch is collapsed), then completed. Ungrouped runs (no `batchId`) emit
   *  flat. Grouping is order-independent: a header is emitted on first sight of
   *  each batchId and ALL of that batch's children follow it, regardless of
   *  insertion order — so a batch is never split across an ungrouped run.
   *
   *  When `filter` is non-empty, both sections narrow to entries whose `agent`
   *  OR `taskPreview` matches (case-insensitive substring). A batch with no
   *  matching children is dropped entirely (no header). */
  private entries(): Array<
    | { kind: "running"; ref: RunView }
    | { kind: "batchHeader"; section: "running" | "completed"; batchId: string; running: number; done: number }
    | { kind: "completed"; ref: SubagentRun }
  > {
    const q = this.filter.trim().toLowerCase();
    const matches = (agent: string | undefined, preview: string): boolean =>
      !q || (agent ?? "").toLowerCase().includes(q) || preview.toLowerCase().includes(q);
    const allRunning = (this.getRunning?.() ?? []).filter((r) => matches(r.actor, r.latestAction ?? ""));

    const runningEntries: Array<
      | { kind: "running"; ref: RunView }
      | { kind: "batchHeader"; section: "running" | "completed"; batchId: string; running: number; done: number }
    > = [];
    const seenBatches = new Set<string>();
    for (const r of allRunning) {
      const bid = r.batchId;
      if (bid) {
        // Collect ALL of this batch's children under one header, anchored at the
        // batch's first sight — so grouping is correct regardless of insertion
        // order (a batch is never split across an interleaved ungrouped run).
        if (seenBatches.has(bid)) continue;
        seenBatches.add(bid);
        const children = allRunning.filter((x) => x.batchId === bid);
        const done = children.filter((x) => isTerminalStatus(x.status)).length;
        runningEntries.push({
          kind: "batchHeader",
          section: "running",
          batchId: bid,
          running: children.length - done,
          done,
        });
        if (!this.collapsedBatches.has(bid)) {
          for (const c of children) runningEntries.push({ kind: "running", ref: c });
        }
      } else {
        runningEntries.push({ kind: "running", ref: r });
      }
    }

    // Completed: group by batchToolCallId (deficit 4b), flat otherwise. Mirrors
    // the running grouping; the collapse key (the batch's toolCallId) is shared
    // with the running section so a batch stays collapsed across its transition.
    const allCompleted = this.runs.filter((r) => matches(r.agent, r.taskPreview));
    const capped = !q && !this.showAll ? allCompleted.slice(-COMPLETED_CAP) : allCompleted;
    const completedEntries: Array<
      | { kind: "completed"; ref: SubagentRun }
      | { kind: "batchHeader"; section: "running" | "completed"; batchId: string; running: number; done: number }
    > = [];
    const seenCompletedBatches = new Set<string>();
    for (const r of capped) {
      const bid = r.batchToolCallId;
      if (bid) {
        if (seenCompletedBatches.has(bid)) continue;
        seenCompletedBatches.add(bid);
        const children = capped.filter((x) => x.batchToolCallId === bid);
        completedEntries.push({
          kind: "batchHeader",
          section: "completed",
          batchId: bid,
          running: 0,
          done: children.length,
        });
        if (!this.collapsedBatches.has(bid)) {
          for (const c of children) completedEntries.push({ kind: "completed", ref: c });
        }
      } else {
        completedEntries.push({ kind: "completed", ref: r });
      }
    }

    return [...runningEntries, ...completedEntries];
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
      // A pending abort confirm is cancelled by Esc WITHOUT closing the viewer
      // (Frontier A) — the confirm is a transient sub-state (mirrors n).
      if (this.confirmAbortId !== undefined) {
        this.confirmAbortId = undefined;
        this.invalidate();
        return;
      }
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
    // Per-child abort confirm (Frontier A): while confirming, only y/n resolve
    // (Esc is handled above); nav/enter/printable are ignored so a stray key
    // can't follow, filter, or abort mid-confirm.
    if (this.confirmAbortId !== undefined) {
      if (data === "y" || data === "Y") {
        const id = this.confirmAbortId;
        this.confirmAbortId = undefined;
        this.onAbort?.(id);
        this.invalidate();
      } else if (data === "n" || data === "N") {
        this.confirmAbortId = undefined;
        this.invalidate();
      }
      return;
    }
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
    if (data === "x" && !this.filter) {
      // Per-child abort (Frontier A): only triggers on a Running entry; a
      // non-running selection falls through to filter input (so 'x' can filter).
      const entries = this.entries();
      const e = entries[this.selected];
      if (e?.kind === "running") {
        this.confirmAbortId = e.ref.id;
        this.invalidate();
        return;
      }
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
      if (e.kind === "batchHeader") {
        if (this.collapsedBatches.has(e.batchId)) this.collapsedBatches.delete(e.batchId);
        else this.collapsedBatches.add(e.batchId);
        // The header's index is stable across the toggle (it precedes its
        // children), so the cursor stays on it — no clamp needed.
        this.invalidate();
        return;
      }
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

    const runningEntries = entries.filter(
      (e) => e.kind === "running" || (e.kind === "batchHeader" && e.section === "running"),
    ) as Array<
      | { kind: "running"; ref: RunView }
      | { kind: "batchHeader"; section: "running" | "completed"; batchId: string; running: number; done: number }
    >;
    if (runningEntries.length > 0) {
      const runningTitle = th.fg("accent", th.bold(" Running "));
      lines.push(truncateToWidth(runningTitle + th.fg("borderMuted", "─".repeat(Math.max(0, width - 9))), width));
      for (const e of runningEntries) {
        const cur = entries.indexOf(e) === this.selected;
        if (e.kind === "batchHeader") {
          const collapsed = this.collapsedBatches.has(e.batchId);
          const glyph = collapsed ? "▶" : "▼";
          const counts = e.done > 0 ? `${e.running} running / ${e.done} done` : `${e.running} running`;
          const header = `${th.fg("accent", th.bold(`${glyph} subagents batch`))} ${th.fg("dim", `· ${counts}`)}`;
          lines.push(truncateToWidth(` ${cur ? th.bg("selectedBg", `▶ ${header}`) : `  ${header}`}`, width));
          continue;
        }
        const v = e.ref;
        const indented = Boolean(v.batchId);
        const terminal = isTerminalStatus(v.status);
        // Terminal batch child lingering in the registry (k/N until endBatch):
        // plain theme-free header via runHeader (first production adoption);
        // its elapsed is already frozen at endedAt by buildRunView.
        if (indented && terminal) {
          const body = cur ? th.bg("selectedBg", `▶ ${runHeader(v)}`) : th.fg("dim", `✓ ${runHeader(v)}`);
          lines.push(truncateToWidth(`    ${body}`, width));
          continue;
        }
        const row: ActivityRow = {
          status: v.status,
          actor: v.actor,
          model: v.modelSeg,
          elapsedMs: v.elapsedMs,
          toolCalls: v.toolCallCount,
          latestAction: summarizeLatestAction(v.history) ?? truncateToWidth(v.latestAction ?? "", 40),
        };
        // Badge column via renderBadge (empty string when no badgeText) — first
        // production adoption; kept out of ActivityRow.badge to avoid double render.
        const head = `${renderBadge(v, th)}${renderActivityRow(row, th)}`;
        // Indented child (under a batch header) or flat ungrouped row — prefixes
        // kept byte-identical to pre-Task-3 so existing visuals are unchanged.
        // A completed-status batch child renders greyed with a ✓ checkmark but
        // stays selectable (follow shows its frozen trace); the ungrouped
        // branch is untouched (singular subagent runs never carry "completed").
        if (indented) {
          const body = cur ? th.bg("selectedBg", `▶ ${head}`) : `  ${head}`;
          lines.push(truncateToWidth(`    ${body}`, width));
        } else {
          lines.push(truncateToWidth(` ${cur ? th.bg("selectedBg", `▶ ${head}`) : `  ${head}`}`, width));
        }
      }
      lines.push("");
    }

    const title = th.fg("accent", th.bold(" Subagent runs "));
    lines.push(truncateToWidth(title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 15))), width));
    lines.push("");
    const completed = entries.filter(
      (e) => e.kind === "completed" || (e.kind === "batchHeader" && e.section === "completed"),
    ) as Array<
      | { kind: "completed"; ref: SubagentRun }
      | { kind: "batchHeader"; section: "completed"; batchId: string; running: number; done: number }
    >;
    if (completed.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "No subagent runs on this branch.")}`, width));
    } else {
      for (const e of completed) {
        const cur = entries.indexOf(e) === this.selected;
        if (e.kind === "batchHeader") {
          const collapsed = this.collapsedBatches.has(e.batchId);
          const glyph = collapsed ? "▶" : "▼";
          const header = `${th.fg("accent", th.bold(`${glyph} subagents batch`))} ${th.fg("dim", `· ${e.done} children`)}`;
          lines.push(truncateToWidth(` ${cur ? th.bg("selectedBg", `▶ ${header}`) : `  ${header}`}`, width));
          continue;
        }
        const r = e.ref;
        const indented = Boolean(r.batchToolCallId);
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
        // Indented batch child (mirrors the Running section's indentation); the
        // ungrouped singular row is byte-identical to before.
        if (indented) {
          const body = cur ? th.bg("selectedBg", `▶ ${head}`) : `  ${head}`;
          lines.push(truncateToWidth(`    ${body}`, width));
        } else {
          lines.push(truncateToWidth(` ${cur ? th.bg("selectedBg", `▶ ${head}`) : `  ${head}`}`, width));
        }
      }
    }
    const totalCompleted = this.runs.length;
    // "showing X of Y" counts actual completed RUNS — a batch header line is
    // not a run (P4: it was previously counted, inflating X beyond the cap).
    const showing = completed.filter((e) => e.kind === "completed").length;
    if (!this.filter && !this.showAll && totalCompleted > COMPLETED_CAP) {
      lines.push(
        truncateToWidth(`  ${th.fg("dim", `showing ${showing} of ${totalCompleted} • press 'a' to show all`)}`, width),
      );
    }
    lines.push("");
    if (this.filter) {
      const n = entries.length;
      lines.push(
        truncateToWidth(
          `  ${th.fg("accent", `filter:`)} "${this.filter}" — ${n} match${n === 1 ? "" : "es"} • esc clear`,
          width,
        ),
      );
    } else {
      lines.push(truncateToWidth(`  ${th.fg("dim", "↑↓ select • enter view/follow • esc close")}`, width));
    }
    lines.push("");
    if (this.confirmAbortId !== undefined) {
      lines.push(truncateToWidth(` ${th.fg("warning", th.bold("Abort this subagent? y/N"))}`, width));
      lines.push("");
    }
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
        `  ${th.fg("accent", `#${r.index}`)} ${th.fg("muted", r.agent ?? "general-purpose")} ▸ ${r.model} • ${r.status} • ${fmtElapsed(r.elapsedMs)}${absTime}${usageStr}`,
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
      // LIVE — refresh the snapshot from the RunView each tick. elapsedMs is
      // now - startedAt live, frozen at endedAt once terminal (buildRunView) —
      // no local clock math. A terminal batch child still lingering in the
      // registry (kept for k/N until endBatch) shows its terminal status with
      // a frozen elapsed instead of ticking "running" forever.
      this.followedSnapshot = {
        history: r.history ?? [],
        model: r.modelSeg,
        agent: r.actor,
        elapsedMs: r.elapsedMs,
      };
      this.finalizingTicks = 0;
      status = r.status;
      model = r.modelSeg;
      elapsedMs = r.elapsedMs;
      agent = r.actor;
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
        // Elapsed freezes at the last live RunView.elapsedMs — no local clock math.
        elapsedMs = this.followedSnapshot?.elapsedMs ?? 0;
        agent = this.followedSnapshot?.agent;
      }
    }

    const agentLabel = agent ?? "general-purpose";
    // Glyph via the canonical activityGlyph table (activityGlyph's adoption
    // deletes followGlyph); only follow's two synthetic statuses (finalizing /
    // ended — not ActivityStatus vocabulary) keep their local dim glyphs.
    const { icon, color } =
      status === "finalizing" || status === "ended"
        ? { icon: status === "finalizing" ? "…" : "–", color: "dim" }
        : activityGlyph(status as ActivityStatus);
    const glyph = th.fg(color as Parameters<Theme["fg"]>[0], icon);
    const head = `${glyph} ${th.fg("accent", agentLabel)} ▸ ${th.fg("muted", model)} • ${th.fg("muted", status)} • ${fmtElapsed(elapsedMs)}${usageStr}`;
    lines.push(truncateToWidth(`  ${head}`, width));
    lines.push(truncateToWidth(th.fg("borderMuted", "─".repeat(Math.max(0, width))), width));

    const traceWindow = (this.followedSnapshot?.history ?? []).slice(-FOLLOW_TRACE_LINES);
    const trace = traceWindow.map((e, i) =>
      formatHistoryLine(e, { matchedCallArgs: matchedCallArgsFor(traceWindow, i) }),
    );
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
