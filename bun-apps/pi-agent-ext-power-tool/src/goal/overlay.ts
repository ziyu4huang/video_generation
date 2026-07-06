/**
 * goal/overlay.ts — persistent above-editor widget for the active /goal.
 *
 * Mirrors TodoOverlay's lifecycle (setWidget + aboveEditor placement) so the
 * two persistent stateful features in power-tool share ONE display mechanism.
 *
 * Unlike the old `ctx.ui.setStatus("goal", …)` path (a bare, uncolored footer
 * fragment with no label and no per-status color), this widget renders a
 * theme-colored single line:
 *
 *   🎯 active 1m23s · iter 3  <dim objective…>
 *
 * with the status token colored by status (active=accent, paused/budget=
 * warning, complete=success). On goal_complete it flashes:
 *
 *   ✓ goal complete  <dim objective…>
 *
 * for ~8s, then hides. No 1s heartbeat setInterval — the widget re-renders
 * naturally during an agent turn (footer re-renders on every streaming chunk);
 * when idle, a slightly stale elapsed is acceptable (same trade-off as
 * TodoOverlay, which has no timer either).
 *
 * Lifecycle:
 *   - goal.ts calls setUICtx(ctx.ui) on session_start
 *   - goal.ts calls update(activeGoal) on every state change
 *   - goal.ts calls showCompletion(text) on goal_complete
 *   - goal.ts calls dispose() on session_shutdown
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI } from "@earendil-works/pi-tui";
import type { ActiveGoal } from "./format.js";
import { formatGoalCompletionLine, formatGoalOverlayLine } from "./format.js";

const WIDGET_KEY = "pi-goal";
const COMPLETION_FLASH_MS = 8_000;

/**
 * Minimal surface goal.ts depends on. Declared here so tests can inject a
 * mock without importing the real class (and without goal.ts ↔ overlay.ts
 * forming a value-level cycle).
 */
export interface GoalOverlayLike {
	setUICtx(ctx: ExtensionUIContext): void;
	update(goal: ActiveGoal | undefined): void;
	showCompletion(objective: string): void;
	dispose(): void;
}

export class GoalOverlay implements GoalOverlayLike {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private current: ActiveGoal | undefined;
	private flashObjective: string | undefined;
	private flashTimer: ReturnType<typeof setTimeout> | undefined;

	setUICtx(ctx: ExtensionUIContext): void {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	/** Push the latest goal state. A new active goal supersedes any completion flash. */
	update(goal: ActiveGoal | undefined): void {
		this.current = goal;
		if (goal) this.clearFlash();
		this.sync();
	}

	/** Show the transient "✓ goal complete" flash, auto-hiding after ~8s. */
	showCompletion(objective: string): void {
		this.flashObjective = objective;
		this.clearFlashTimer();
		this.flashTimer = setTimeout(() => {
			this.flashTimer = undefined;
			this.flashObjective = undefined;
			this.sync();
		}, COMPLETION_FLASH_MS);
		this.sync();
	}

	dispose(): void {
		this.clearFlashTimer();
		this.flashObjective = undefined;
		this.current = undefined;
		if (this.uiCtx?.setWidget) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
	}

	// ─── Internal ───────────────────────────────────────────────────────────

	private sync(): void {
		// Non-UI modes (RPC/CLI) have no widget surface — silently no-op.
		if (!this.uiCtx?.setWidget) return;

		const hasContent = this.flashObjective !== undefined || this.current !== undefined;
		if (!hasContent) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			return;
		}

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(theme, width),
						invalidate: () => {
							this.widgetRegistered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	private renderWidget(theme: Theme, width: number): string[] {
		if (this.flashObjective !== undefined) {
			return [formatGoalCompletionLine(this.flashObjective, theme, width), ""];
		}
		if (this.current) {
			return [formatGoalOverlayLine(this.current, theme, width), ""];
		}
		return [];
	}

	private clearFlash(): void {
		this.clearFlashTimer();
		this.flashObjective = undefined;
	}

	private clearFlashTimer(): void {
		if (this.flashTimer) {
			clearTimeout(this.flashTimer);
			this.flashTimer = undefined;
		}
	}
}
