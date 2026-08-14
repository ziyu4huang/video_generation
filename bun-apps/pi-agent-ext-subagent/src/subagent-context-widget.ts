/**
 * Unified subagent-context box — an always-on `aboveEditor` widget that
 * live-renders every currently-running subagent activity that is NOT already
 * shown inline by Surface A (the registering tool's own call/result line in the
 * CURRENT turn). Background/concurrent runs register with `foreground: false`;
 * this box filters to those and renders Surface A's rich header format
 * (reusing `renderSubagentCall` / the context-box trace helpers), collapsed to
 * the header + latest single activity line by default. Foreground runs
 * (foreground: true — the current turn's
 * `subagent` / `subagents` calls, rendered inline by their
 * ToolExecutionComponent) are EXCLUDED so the two surfaces never duplicate.
 *
 * Replaces the old below-editor progress widget (subagent-progress-widget.ts,
 * Surface B). Surface C (`/subagents`) stays the on-demand interactive viewer
 * and now also shows background runs for free via the shared registry.
 *
 * Interactivity (Stage A): a `setWidget` factory component is rendered into the
 * editor dock (`widgetContainerAbove/Below`) and the app NEVER focuses it — the
 * TUI routes raw input only to the single `focusedComponent` (the editor), so
 * the box's `handleInput?` is never invoked and it cannot toggle
 * expand/collapse on a key press today. Stage A therefore renders collapsed
 * rich headers only; the live tool trace is reached via `/subagents` (noted in
 * the header). The widget still holds an `expanded` flag + `toggle()` so a
 * LATER stage can flip it via a GLOBAL key path (`ui.onTerminalInput` /
 * `pi.registerShortcut` — neither requires focus) without touching this file.
 * That "make the box interactive" step is the deferred prize in the wayfinder
 * map (ticket 02), out of Stage A's scope.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { InFlightSubagent, SubagentInFlightRegistry } from "@repo/pi-agent-ext-core-runtime";
import { isTerminalStatus } from "@repo/pi-agent-ext-core-runtime";
import {
  capTraceTail,
  formatSubagentTrace,
  latestMessageLine,
  renderSubagentCall,
  STREAMING_EXPANDED_TAIL,
} from "./subagent-tool-render.js";

export interface SubagentContextWidgetOpts {
  /** Live source of in-flight runs (defaults to `registry.list()` at the wiring site). */
  getRunning: () => InFlightSubagent[];
}

/** Indent for each run's block under the count header. */
const INDENT = "  ";

/**
 * Detect the Ctrl-O keystroke in raw terminal input. In terminals Ctrl-O is the
 * C0 control byte 0x0F ("\x0f", charCode 15). Substring-based so a Ctrl-O that
 * co-occurs with other bytes in the same input chunk still triggers; pure so
 * the onTerminalInput handler can be unit-tested without a real terminal.
 */
export function isCtrlO(data: string): boolean {
  return data.includes("\x0f");
}

/**
 * Pick the count-header noun from the actual run mix. A workflow-only run set
 * must NOT be labelled "subagent" (the old fixed noun did exactly that when a
 * single workflow was live). `subagents` = runs with `r.agent !== "workflow"`;
 * `workflows` = the rest. Singular for a lone run of one kind, plural for many
 * of one kind, and the neutral `"runs"` for a mixed set (always ≥2).
 */
export function countNoun(running: InFlightSubagent[]): string {
  const subagents = running.filter((r) => r.agent !== "workflow").length;
  const workflows = running.length - subagents;
  if (workflows === 0) return subagents === 1 ? "subagent" : "subagents";
  if (subagents === 0) return workflows === 1 ? "workflow" : "workflows";
  return "runs";
}

export class SubagentContextWidget {
  /**
   * Collapsed (headers-only) by default. Stage A never wires `toggle()` to a key
   * (the dock component isn't focusable — see the file doc), so in practice the
   * box stays collapsed and the live trace lives in `/subagents`. `toggle()` +
   * `expanded` exist purely so Stage B can surface the inline trace without code
   * churn here.
   */
  private expanded = false;

  constructor(private opts: SubagentContextWidgetOpts) {}

  /** Flip collapsed/expanded. Called by the installer's `toggle` handle, which
   *  the Ctrl-O onTerminalInput hook drives (see installSubagentContextWidget).
   *  render() honors the new state on the next requestRender(). */
  toggle(): void {
    this.expanded = !this.expanded;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  /** Render the box as theme-tagged lines. `[]` when no background runs are live
   *  → invisible (zero screen footprint). Reads the live registry each call. */
  render(theme: Theme): string[] {
    // Surface A renders the current turn's foreground runs inline; the box shows
    // the rest (background/concurrent) so the two never duplicate. `!foreground`
    // also catches omitted/undefined (the registry normalizes to false).
    const running = this.opts.getRunning().filter((r) => !r.foreground);
    if (running.length === 0) return [];
    const noun = countNoun(running);
    // Count header doubles as the discoverability surface: ticket 03 shipped
    // box-expand on Ctrl-O (the onTerminalInput hook), and this header is where
    // the user learns the keystroke — plus the /subagents drill-down for the
    // live tool trace.
    const lines: string[] = [
      ` ${running.length} background ${noun} running · Ctrl-O to expand · /subagents for detail `,
    ];
    for (const r of running) {
      lines.push(...this.renderRun(r, theme));
    }
    return lines;
  }

  /** One run = a rich header line (collapsed: header + latest single activity
   *  line), or header + grouped live trace (expanded). The header reuses Surface
   *  A's `renderSubagentCall`; the collapsed latest-line uses `latestMessageLine`
   *  (prose-else-activity); the expanded trace uses `formatSubagentTrace` (paired
   *  call/result → one `✓`, in-flight `→ …`). `formatSubagentLive` stays the
   *  INLINE tool surface's payload (its 2-line header contract is untouched). */
  private renderRun(r: InFlightSubagent, theme: Theme): string[] {
    // Workflow runs (decision 03 = b2) register into the same registry so they
    // surface here and in /subagents. They don't fit the subagent-shaped
    // model/agent slots (a workflow aggregates agents across models), so render
    // a workflow-specific header. The taskPreview already encodes
    // "<name> · <phase> · k/N agents" (set by WorkflowManager). Collapsed only
    // — no live tool trace; /subagents stays the drill-down for the per-agent
    // trace. Full rendering polish is a follow-up (ticket 02 deferred prize).
    if (r.agent === "workflow") {
      const wfHeader = [theme.bold(theme.fg("toolTitle", "workflow")), theme.fg("dim", `"${r.taskPreview}"`)].join(
        " ▸ ",
      );
      return [`${INDENT}${wfHeader}`];
    }
    const header = renderSubagentCall(
      {
        agent: r.agent,
        model: r.model,
        // Feed the precomputed work-intent strip (not the single-lined
        // taskPreview) so the preamble is stripped on the docked header too
        // (ticket 04, finding 1 — #1101's strip was dead here). Falls back to
        // taskPreview for entries that never populated workIntent.
        task: r.workIntent ?? r.taskPreview,
        resolvedModel: r.resolvedModel,
        // Persist the fallback indicator on the docked header — the registry
        // already carries fellBack/requestedModel from markFallback (ticket 04,
        // finding 3 — the box never passed it, so the `→` was missing here).
        fellBack: r.fellBack,
      },
      theme,
    );
    const history = r.history;
    if (!history || history.length === 0) {
      return [`${INDENT}${header}`];
    }
    if (!this.expanded) {
      // Collapsed: the rich header + ONE latest activity/prose line (so the
      // user sees what the child is doing RIGHT NOW without expanding). Prose
      // (assistant text) renders QUOTED to distinguish it from a tool activity.
      const lines = [`${INDENT}${header}`];
      const live = latestMessageLine(history);
      if (live) lines.push(`${INDENT}${INDENT}${live}`);
      return lines;
    }
    // Expanded: paired call/result → one past-tense `✓`; trailing un-paired
    // call → in-flight `→ …`; compact progress on the in-flight line (else a
    // trailing line). minToolCalls floors the count so a snapshot never visibly
    // regresses (the box polls, so the floor is the current count itself).
    const minToolCalls = history.filter((h) => h.kind === "toolCall").length;
    // Elapsed freeze: a terminal-status run still lingers in the registry until
    // its batch/parent reaps it — its elapsed must FREEZE at `endedAt`, not keep
    // ticking (same pattern as subagent-viewer.ts buildLiveTable).
    const elapsedMs = isTerminalStatus(r.status) && r.endedAt ? r.endedAt - r.startedAt : Date.now() - r.startedAt;
    const trace = formatSubagentTrace(history, elapsedMs, minToolCalls);
    // Cap the trace tail to the SAME policy as the inline streaming-expanded
    // view (STREAMING_EXPANDED_TAIL). Ctrl-O expands BOTH surfaces together
    // via { consume: false } (extensions/subagent.ts), so the cap must hold on
    // both — otherwise a tall background run's expanded box re-trips the
    // whole-TUI fullRender flicker #1104 killed, on the surface #1104 didn't
    // touch (ticket 05, finding 4). The trace here is SEPARATE from the header
    // (the inline surface's payload bundles a 2-line header + trace; here it's
    // a header line + trace), so cap the trace lines directly.
    const traceLines = capTraceTail(trace.split("\n"), STREAMING_EXPANDED_TAIL);
    return [`${INDENT}${header}`, ...traceLines.map((l) => `${INDENT}${INDENT}${l}`)];
  }

  invalidate(): void {
    // No width/theme cache: render() reads live registry state each call. Present
    // for the TUI component contract (mirrors the old progress widget).
  }
}

export interface InstallSubagentContextWidgetOpts {
  registry: SubagentInFlightRegistry;
  /** Dock placement. Defaults to `aboveEditor` (replaces the old belowEditor box). */
  placement?: "aboveEditor" | "belowEditor";
  /** Refresh cadence for the elapsed counter, ms (default 1000). */
  intervalMs?: number;
  /** Injectable for tests (default: global setInterval). */
  setInterval?: typeof setInterval;
  /** Injectable for tests (default: global clearInterval). */
  clearInterval?: typeof clearInterval;
}

const CONTEXT_INTERVAL_MS = 1000;

/**
 * Mount the always-on subagent-context box above the editor. The factory is
 * registered ONCE; its render reads the registry live (filtering to
 * `!foreground`) and returns `[]` when idle (invisible, zero footprint). A timer
 * calls `tui.requestRender()` so the elapsed counter ticks between events. We
 * deliberately do NOT re-call setWidget per tick — re-registration reorders the
 * widget to the end of the list (status-widget.ts note); requestRender avoids
 * that.
 *
 * Safe no-op when `ui` has no setWidget (headless/RPC mode) — mirrors the old
 * installer so the extension loads identically in non-interactive hosts.
 */
export interface SubagentContextWidgetHandle {
  /** Stop the refresh timer (idempotent). */
  dispose: () => void;
  /** Flip expanded/collapsed and request a re-render so the new state shows.
   *  Driven by the Ctrl-O onTerminalInput hook wired at the install site. */
  toggle: () => void;
}

export function installSubagentContextWidget(
  ui: Pick<ExtensionContext["ui"], "setWidget"> | undefined,
  opts: InstallSubagentContextWidgetOpts,
): SubagentContextWidgetHandle {
  if (!ui || typeof ui.setWidget !== "function") return { dispose: () => {}, toggle: () => {} };
  const placement = opts.placement ?? "aboveEditor";
  const intervalMs = opts.intervalMs ?? CONTEXT_INTERVAL_MS;
  const si = opts.setInterval ?? setInterval;
  const ci = opts.clearInterval ?? clearInterval;
  const widget = new SubagentContextWidget({ getRunning: () => opts.registry.list() });

  // The host invokes the factory with the live TUI. Capture it so both the
  // refresh timer and the returned `toggle` handle can call requestRender().
  let tuiRef: { requestRender: () => void } | undefined;
  let timerId: ReturnType<typeof setInterval> | undefined;
  let started = false;
  // Factory signature mirrors the old progress widget + display.ts:
  // (tui, theme) => { render: (width?) => string[]; invalidate: () => void }.
  const factory = (tui: unknown, theme: Theme) => {
    // Refresh the TUI reference every invocation (theme change re-calls the
    // factory); start the refresh timer exactly once.
    tuiRef = tui as { requestRender: () => void };
    if (!started) {
      started = true;
      // Idle churn guard (P5): with zero background runs the box renders `[]`
      // (invisible) and nothing can change — a requestRender would still wake
      // the whole TUI every tick. Skip the render when there is nothing live;
      // the first event of a new background run re-renders on its own ticks.
      timerId = si(() => {
        if (!opts.registry.list().some((r) => !r.foreground)) return;
        tuiRef?.requestRender();
      }, intervalMs);
    }
    return {
      render: () => widget.render(theme),
      invalidate: () => widget.invalidate(),
    };
  };

  ui.setWidget("subagents", factory, { placement });

  return {
    dispose: () => {
      if (timerId !== undefined) ci(timerId);
      timerId = undefined;
    },
    toggle: () => {
      widget.toggle();
      tuiRef?.requestRender();
    },
  };
}
