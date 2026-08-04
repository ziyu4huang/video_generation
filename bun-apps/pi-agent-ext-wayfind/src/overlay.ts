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
import { readEffortMeta } from "./map.js";

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
  private activeEffort: string | undefined;
  private activeCwd: string | undefined;
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

  /** Track the active effort. It no longer paints a permanent idle line — it
   *  only augments a transient action line with the effort's manifest status.
   *  (Still consumed by /wayfind status + the coordinator-yield seam.) */
  setActiveEffort(effort: string | undefined, cwd: string | undefined): void {
    this.activeEffort = effort;
    this.activeCwd = cwd;
    this.refresh?.();
  }

  /** States that represent a sustained, multi-turn MODE (the plan coordinator
   *  yields throughout) — they must NOT be auto-cleared at turn_end, persisting
   *  until their explicit end (/grill done) or session_shutdown. One-shot
   *  command states (charting, working-ticket, to-tickets, …) are NOT here. */
  private static readonly SUSTAINED_STATES: ReadonlySet<WayfindState> = new Set<WayfindState>([
    "grilling",
    "grilling-docs",
  ]);

  /** Clear a one-shot transient action line (called on turn_end) so the bar
   *  doesn't keep a stale "charting …" banner after the action's turn ends.
   *  Sustained states are left intact. No-op when no transient is set; only
   *  refreshes when it actually clears something. */
  clearTransientUnlessSustained(): void {
    if (this.state !== undefined && !WayfindOverlay.SUSTAINED_STATES.has(this.state)) {
      this.state = undefined;
      this.text = undefined;
      this.refresh?.();
    }
  }

  /** Clear the section (session_shutdown). */
  dispose(): void {
    this.state = undefined;
    this.text = undefined;
    this.activeEffort = undefined;
    this.activeCwd = undefined;
  }

  /** Read the active effort's manifest status, treating any fs error (a
   *  concurrent map.md write/removal — the TOCTOU window between existsSync
   *  and readFileSync inside readEffortMeta) as `(no manifest)` so render() never
   *  throws on a hot path. */
  private activeStatus(): string {
    if (!this.activeEffort || !this.activeCwd) return "(no manifest)";
    try {
      return readEffortMeta(this.activeCwd, this.activeEffort)?.status ?? "(no manifest)";
    } catch {
      return "(no manifest)";
    }
  }

  /** Render the wayfind section (0 or 1 branded status-bar line). Shows the
   *  transient action line only (augmented with the active effort's manifest
   *  status when one is set); renders NOTHING when idle, so the shared status
   *  bar stays clean between wayfind actions. */
  render(_theme: Theme, _width: number): string[] {
    if (this.state !== undefined && this.text !== undefined) {
      const base = `${BRAND_PREFIX}${STATE_EMOJI[this.state]} ${this.text}`;
      // Augment the action line with the manifest status so it's always visible
      // during an active effort. No active effort → plain line.
      if (this.activeEffort && this.activeCwd) {
        return [`${base} · ${this.activeStatus()}`];
      }
      return [base];
    }
    // Idle (no transient action) → no wayfind line: the status bar stays clean.
    // The active effort is still tracked for augmentation + /wayfind status.
    return [];
  }
}
