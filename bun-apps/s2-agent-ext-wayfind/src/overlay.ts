/**
 * overlay.ts — wayfind's status-line section for the shared CoreTaskStatusWidget
 * (owned by s2-agent-ext-task, reached via its `globalThis.__piCoreTaskStatusWidget`
 * singleton — no package import; see docs/adr/0004).
 *
 * Renders ONE branded status-bar line — `🧭 wayfind │ {emoji} {text}` — so the
 * wayfind section is instantly distinguishable from generic log/output lines.
 * The caller picks a `WayfindState` (→ its emoji) and supplies the descriptive
 * text; the overlay owns the consistent frame + the state→emoji map (single
 * source of truth, unit-tested).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { readEffortMeta } from "./lifecycle.js";

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
  | "handoff"
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
  handoff: "🤝",
  done: "✅",
};

const BRAND_PREFIX = "🧭 wayfind │ ";

export class WayfindOverlay {
  private state: WayfindState | undefined;
  private text: string | undefined;
  private activeEffort: string | undefined;
  private activeCwd: string | undefined;
  private refresh: (() => void) | undefined;
  /** Opt-in persistent status bar: when true + idle + active (non-complete)
   *  effort, render() paints `🧭 wayfind │ 🗺️ <effort> · <status>`. Default
   *  false — the shared status bar stays clean unless the user opts in via
   *  `/wayfind statusbar on`. No file IO lives in the class (kept test-safe):
   *  index.ts applies the persisted default once at startup. */
  private statusBarOn = false;

  /** Register the composite widget's update() as the refresh callback. */
  setRefresh(fn: () => void): void {
    this.refresh = fn;
  }

  /** Flip the opt-in persistent status bar. Refreshes so the line appears /
   *  disappears immediately. */
  setStatusBarEnabled(on: boolean): void {
    this.statusBarOn = on;
    this.refresh?.();
  }

  /** Read whether the opt-in persistent status bar is on. */
  isStatusBarEnabled(): boolean {
    return this.statusBarOn;
  }

  /** Set the current status (state picks the emoji) + descriptive text, and re-render. */
  setLine(state: WayfindState, text: string): void {
    this.state = state;
    this.text = text;
    this.refresh?.();
  }

  /** Track the active effort. It no longer paints a permanent idle line — it
   *  only augments a transient action line with the effort's manifest status
   *  (still consumed by /wayfind status). */
  setActiveEffort(effort: string | undefined, cwd: string | undefined): void {
    this.activeEffort = effort;
    this.activeCwd = cwd;
    this.refresh?.();
  }

  /** States that represent a sustained, multi-turn MODE — they must NOT be
   *  auto-cleared at turn_end, persisting until their explicit end (/grill done)
   *  or session_shutdown. One-shot command states (charting, working-ticket,
   *  to-tickets, …) are NOT here. */
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
    // Idle (no transient action). Two modes:
    //  • Default (statusBarOn=false) → no wayfind line: the shared status bar
    //    stays clean between wayfind actions (the gating fix for the prior
    //    b1ce5722/e8430ecf failure where the idle line monopolized the bar).
    //  • Opt-in (statusBarOn=true) → paint an idle effort line, but ONLY when an
    //    effort is active AND not yet complete (auto-hides on completion/clear).
    //    The active effort is still tracked for augmentation + /wayfind status.
    if (this.statusBarOn && this.activeEffort && this.activeCwd && this.activeStatus() !== "complete") {
      return [`${BRAND_PREFIX}🗺️ ${this.activeEffort} · ${this.activeStatus()}`];
    }
    return [];
  }
}
