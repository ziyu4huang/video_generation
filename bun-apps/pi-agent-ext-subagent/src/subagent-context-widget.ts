/**
 * Unified subagent-context box — an always-on `aboveEditor` widget that
 * live-renders every currently-running subagent activity that is NOT already
 * shown inline by Surface A (the registering tool's own call/result line in the
 * CURRENT turn). Background/concurrent runs register with `foreground: false`;
 * this box filters to those and renders Surface A's rich header format
 * (reusing `renderSubagentCall` / `formatSubagentLive`), collapsed to the header
 * line by default. Foreground runs (foreground: true — the current turn's
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
import type { InFlightSubagent, SubagentInFlightRegistry } from "./index.js";
import { formatSubagentLive, renderSubagentCall } from "./subagent-tool.js";

export interface SubagentContextWidgetOpts {
  /** Live source of in-flight runs (defaults to `registry.list()` at the wiring site). */
  getRunning: () => InFlightSubagent[];
}

/** Indent for each run's block under the count header. */
const INDENT = "  ";

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

  /** Flip collapsed/expanded. Present for Stage B (global keybinding); a no-op
   *  for rendering today since nothing calls it in Stage A. */
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
    const noun = running.length === 1 ? "subagent" : "subagents";
    // Count header doubles as the drill-down hint: the collapsed box shows only
    // headers, so direct the user to /subagents for the live tool trace.
    const lines: string[] = [` ${running.length} background ${noun} running · /subagents for detail `];
    for (const r of running) {
      lines.push(...this.renderRun(r, theme));
    }
    return lines;
  }

  /** One run = a rich header line (collapsed), or header + live trace (expanded).
   *  The header reuses Surface A's `renderSubagentCall`; the trace reuses
   *  `formatSubagentLive` — the SAME formatting helpers as the inline surface,
   *  just a different render slot. */
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
      { agent: r.agent, model: r.model, task: r.taskPreview, resolvedModel: r.resolvedModel },
      theme,
    );
    const history = r.history;
    if (!this.expanded || !history || history.length === 0) {
      return [`${INDENT}${header}`];
    }
    // minToolCalls floors the displayed count so a snapshot never visibly
    // regresses (mirrors the singular tool's running-max). The box polls (no
    // per-run running max), so the floor is the current count itself.
    const minToolCalls = history.filter((h) => h.kind === "toolCall").length;
    const live = formatSubagentLive(history, Date.now() - r.startedAt, minToolCalls);
    return [`${INDENT}${header}`, ...live.split("\n").map((l) => `${INDENT}${INDENT}${l}`)];
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
export function installSubagentContextWidget(
  ui: Pick<ExtensionContext["ui"], "setWidget"> | undefined,
  opts: InstallSubagentContextWidgetOpts,
): { dispose: () => void } {
  if (!ui || typeof ui.setWidget !== "function") return { dispose: () => {} };
  const placement = opts.placement ?? "aboveEditor";
  const intervalMs = opts.intervalMs ?? CONTEXT_INTERVAL_MS;
  const si = opts.setInterval ?? setInterval;
  const ci = opts.clearInterval ?? clearInterval;
  const widget = new SubagentContextWidget({ getRunning: () => opts.registry.list() });

  let timerId: ReturnType<typeof setInterval> | undefined;
  let started = false;
  // Factory signature mirrors the old progress widget + display.ts:
  // (tui, theme) => { render: (width?) => string[]; invalidate: () => void }.
  const factory = (tui: unknown, theme: Theme) => {
    // Start the refresh timer exactly once — the app may invoke the factory more
    // than once (e.g. on theme change); guard against a duplicate interval.
    if (!started) {
      started = true;
      timerId = si(() => (tui as { requestRender: () => void }).requestRender(), intervalMs);
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
  };
}
