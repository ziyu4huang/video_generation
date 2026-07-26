/**
 * overlay.ts — wayfind's status-line section for the shared CoreTaskStatusWidget
 * (owned by pi-agent-ext-core-task, reached via its `globalThis.__piCoreTaskStatusWidget`
 * singleton — no package import; see docs/adr/0004).
 *
 * Replaces the previous direct ctx.ui.setStatus(PKG_NAME, text) calls scattered
 * across commands.ts — a single state-holder that renders one line into the
 * composite widget instead of a second, independent footer entry.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

export class WayfindOverlay {
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

  /** Render the wayfind section (0 or 1 line). */
  render(_theme: Theme, _width: number): string[] {
    return this.line !== undefined ? [this.line] : [];
  }
}
