/**
 * goal/overlay.ts — goal section renderer for the CoreTaskStatusWidget.
 *
 * As of the overlay-unification refactor this no longer owns a `setWidget`
 * lifecycle. The CoreTaskStatusWidget (shared/status-widget.ts) owns ONE
 * above-editor widget key and renders this section alongside the todo section
 * in a fixed order. GoalOverlay is now a state-holder that exposes
 * `render(theme, width)` and pokes `refresh()` (the composite's update) when
 * its content changes.
 *
 * The `GoalOverlayLike` interface is unchanged (setUICtx/update/showCompletion/
 * dispose) so `goal.ts` and its mock-based tests need no changes — setUICtx is
 * now a harmless no-op (the composite owns the UI ctx).
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { ActiveGoal } from "./format.js";
import { formatGoalCompletionLine, formatGoalOverlayLine } from "./format.js";

const COMPLETION_FLASH_MS = 8_000;

/**
 * The surface goal.ts depends on. Unchanged from before the refactor so goal.ts
 * and goal.test.ts keep working verbatim. (render + setRefresh are concrete
 * methods on the class, used by the composite in index.ts, not part of this
 * DI interface — the mock doesn't need them.)
 */
export interface GoalOverlayLike {
	setUICtx(ctx: ExtensionUIContext): void;
	update(goal: ActiveGoal | undefined): void;
	showCompletion(objective: string): void;
	dispose(): void;
}

export class GoalOverlay implements GoalOverlayLike {
	private current: ActiveGoal | undefined;
	private flashObjective: string | undefined;
	private flashTimer: ReturnType<typeof setTimeout> | undefined;
	private refresh: (() => void) | undefined;

	/** No-op now — the CoreTaskStatusWidget owns the UI ctx. Kept for DI compat. */
	setUICtx(_ctx: ExtensionUIContext): void {}

	/** Register the composite's update as the refresh callback. */
	setRefresh(fn: () => void): void {
		this.refresh = fn;
	}

	/** Push the latest goal state. A new active goal supersedes any completion flash. */
	update(goal: ActiveGoal | undefined): void {
		this.current = goal;
		if (goal) this.clearFlash();
		this.refresh?.();
	}

	/** Show the transient "✓ goal complete" flash, auto-clearing after ~8s. */
	showCompletion(objective: string): void {
		this.flashObjective = objective;
		this.clearFlashTimer();
		this.flashTimer = setTimeout(() => {
			this.flashTimer = undefined;
			this.flashObjective = undefined;
			this.refresh?.();
		}, COMPLETION_FLASH_MS);
		this.refresh?.();
	}

	dispose(): void {
		this.clearFlashTimer();
		this.flashObjective = undefined;
		this.current = undefined;
	}

	/** Render the goal section (1 line). Empty if no goal and no flash. */
	render(theme: Theme, width: number): string[] {
		if (this.flashObjective !== undefined) {
			return [formatGoalCompletionLine(this.flashObjective, theme, width)];
		}
		if (this.current) {
			return [formatGoalOverlayLine(this.current, theme, width)];
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
