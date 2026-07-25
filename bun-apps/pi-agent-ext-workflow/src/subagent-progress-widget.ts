/**
 * Always-on below-editor widget showing one live line per running subagent —
 * visually identical to the /subagents viewer's Running row (same renderActivityRow).
 * Renders [] when idle → invisible (zero screen footprint). Reads the shared
 * in-flight registry live on each render; refresh cadence is driven by the
 * wiring's timer (tui.requestRender), not here.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { InFlightSubagent } from "@repo/pi-agent-ext-subagent";
import { summarizeLatestAction } from "@repo/pi-agent-ext-subagent";
import { type ActivityRow, renderActivityRow } from "./display.js";

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
