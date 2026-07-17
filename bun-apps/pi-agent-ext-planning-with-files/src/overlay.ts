/**
 * overlay.ts — planning-with-files' status-line section for the shared
 * PowerToolStatusWidget (owned by pi-agent-ext-goal-todo, see
 * getSharedStatusWidget()).
 *
 * Replaces the previous direct ctx.ui.setStatus(PKG_NAME, text) calls scattered
 * across runtime.ts and commands.ts — a single state-holder that renders one
 * line into the composite widget instead of a second, independent footer
 * entry. The yield message ("... — /goal or /grill driving, injection
 * yielded") is preserved as visible text here — it is useful information, not
 * noise; only the footer-line duplication goes away.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

export class PlanningOverlay {
  private line: string | undefined;
  private refresh: (() => void) | undefined;

  /** Register the composite widget's update() as the refresh callback. */
  setRefresh(fn: () => void): void {
    this.refresh = fn;
  }

  /** Set the current status line and trigger a re-render. */
  setLine(text: string): void {
    this.line = text;
    this.refresh?.();
  }

  /** Clear the section (session_shutdown). */
  dispose(): void {
    this.line = undefined;
  }

  /** Render the planning-with-files section (0 or 1 line). */
  render(_theme: Theme, _width: number): string[] {
    return this.line !== undefined ? [this.line] : [];
  }
}
