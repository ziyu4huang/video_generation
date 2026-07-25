/**
 * Always-on below-editor widget showing one live line per running subagent —
 * visually identical to the /subagents viewer's Running row (same renderActivityRow).
 * Renders [] when idle → invisible (zero screen footprint). Reads the shared
 * in-flight registry live on each render; refresh cadence is driven by the
 * wiring's timer (tui.requestRender), not here.
 */
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { type ActivityRow, renderActivityRow } from "./agent-row-display.js";
import type { InFlightSubagent, SubagentInFlightRegistry } from "./index.js";
import { summarizeLatestAction } from "./index.js";

export interface SubagentProgressWidgetOpts {
  getRunning: () => InFlightSubagent[];
}

export class SubagentProgressWidget {
  constructor(private opts: SubagentProgressWidgetOpts) {}

  render(theme: Theme): string[] {
    const running = this.opts.getRunning();
    if (running.length === 0) return [];
    const noun = running.length === 1 ? "subagent" : "subagents";
    const header = theme.fg("accent", theme.bold(` ${running.length} ${noun} running `));
    const lines: string[] = [header];
    for (const r of running) {
      const toolCalls = r.history?.filter((h) => h.kind === "toolCall").length ?? 0;
      const row: ActivityRow = {
        status: "running",
        actor: r.agent ?? "general-purpose",
        model: r.resolvedModel ?? r.model,
        elapsedMs: Date.now() - r.startedAt,
        toolCalls,
        latestAction: summarizeLatestAction(r.history) ?? truncateToWidth(r.taskPreview, 40),
      };
      lines.push(`  ${renderActivityRow(row, theme)}`);
    }
    return lines;
  }

  invalidate(): void {
    // No width/theme cache: render() reads live state each call. Present for the
    // TUI component contract; a no-op matches display.ts's widget factory.
  }
}

export interface InstallSubagentProgressWidgetOpts {
  registry: SubagentInFlightRegistry;
  placement?: "belowEditor" | "aboveEditor";
  /** Refresh cadence for the elapsed counter, ms (default 1000). */
  intervalMs?: number;
  /** Injectable for tests (default: global setInterval). */
  setInterval?: typeof setInterval;
  /** Injectable for tests (default: global clearInterval). */
  clearInterval?: typeof clearInterval;
}

const PROGRESS_INTERVAL_MS = 1000;

/**
 * Mount the always-on subagent-progress widget below the editor. The factory is
 * registered ONCE; its render reads the registry live and returns [] when idle
 * (invisible, zero footprint). A timer calls tui.requestRender() so the elapsed
 * counter ticks between events. We deliberately do NOT re-call setWidget per
 * tick — re-registration reorders the widget to the end of the list
 * (status-widget.ts note); requestRender avoids that.
 *
 * Safe no-op when `ui` has no setWidget (headless/RPC mode).
 */
export function installSubagentProgressWidget(
  ui: Pick<ExtensionContext["ui"], "setWidget"> | undefined,
  opts: InstallSubagentProgressWidgetOpts,
): { dispose: () => void } {
  if (!ui || typeof ui.setWidget !== "function") return { dispose: () => {} };
  const placement = opts.placement ?? "belowEditor";
  const intervalMs = opts.intervalMs ?? PROGRESS_INTERVAL_MS;
  const si = opts.setInterval ?? setInterval;
  const ci = opts.clearInterval ?? clearInterval;
  const widget = new SubagentProgressWidget({ getRunning: () => opts.registry.list() });

  let timerId: ReturnType<typeof setInterval> | undefined;
  let started = false;
  // Factory signature mirrors createWidgetWorkflowDisplay (display.ts):
  // (tui, theme) => { render: () => string[]; invalidate: () => void }.
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
