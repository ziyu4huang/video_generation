/**
 * overlay.ts — wayfind's status-line section for the shared CoreTaskStatusWidget
 * (owned by pi-agent-ext-core-task, reached via its `globalThis.__piCoreTaskStatusWidget`
 * singleton — no package import; see docs/adr/0004).
 *
 * Renders ONE branded status-bar line — `🧭 wayfind │ {emoji} {text}` — so the
 * wayfind section is instantly distinguishable from generic log/output lines.
 * The caller picks a `WayfindState` (→ its emoji) and supplies the descriptive
 * text; the overlay owns the consistent frame + the state→emoji map (single
 * source of truth, unit-tested).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

export type WayfindState =
  | "grilling"
  | "grilling-docs"
  | "charting"
  | "working-ticket"
  | "to-tickets"
  | "to-spec"
  | "seed"
  | "domain-modeling"
  | "sync"
  | "done";

const STATE_EMOJI: Record<WayfindState, string> = {
  grilling: "🔥",
  "grilling-docs": "📚",
  charting: "🗺️",
  "working-ticket": "🎯",
  "to-tickets": "🎫",
  "to-spec": "📝",
  seed: "🌱",
  "domain-modeling": "🧩",
  sync: "🔗",
  done: "✅",
};

const BRAND_PREFIX = "🧭 wayfind │ ";

export class WayfindOverlay {
  private state: WayfindState | undefined;
  private text: string | undefined;
  private refresh: (() => void) | undefined;

  /** Register the composite widget's update() as the refresh callback. */
  setRefresh(fn: () => void): void {
    this.refresh = fn;
  }

  /** Set the current status (state picks the emoji) + descriptive text, and re-render. */
  setLine(state: WayfindState, text: string): void {
    this.state = state;
    this.text = text;
    this.refresh?.();
  }

  /** Clear the section (session_shutdown). */
  dispose(): void {
    this.state = undefined;
    this.text = undefined;
  }

  /** Render the wayfind section (0 or 1 branded status-bar line). */
  render(_theme: Theme, _width: number): string[] {
    if (this.state === undefined || this.text === undefined) return [];
    return [`${BRAND_PREFIX}${STATE_EMOJI[this.state]} ${this.text}`];
  }
}
