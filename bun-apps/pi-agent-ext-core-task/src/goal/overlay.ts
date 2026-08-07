/**
 * goal/overlay.ts — goal section renderer for the CoreTaskStatusWidget.
 *
 * As of the overlay-unification refactor this no longer owns a `setWidget`
 * lifecycle. The CoreTaskStatusWidget (shared/status-widget.ts) owns ONE
 * below-editor widget key and renders this section alongside the todo section
 * in a fixed order. GoalOverlay is now a state-holder that exposes
 * `render(theme, width)` and pokes `refresh()` (the composite's update) when
 * its content changes.
 *
 * The `GoalOverlayLike` interface is unchanged (setUICtx/update/showCompletion/
 * dispose) so `goal.ts` and its mock-based tests need no changes — setUICtx is
 * now a harmless no-op (the composite owns the UI ctx).
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { ActiveGoal, GoalListItem } from "./format.js";
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
	/**
	 * Push the latest goal state. `list` + `headAdvances` (Loop 2 / Task 7) drive
	 * the dim `☰ position/total` queue suffix; both optional + persisted on the
	 * overlay so the frequent single-arg tick callers still refresh correctly.
	 */
	update(goal: ActiveGoal | undefined, list?: GoalListItem[], headAdvances?: number): void;
	showCompletion(objective: string): void;
	dispose(): void;
}

export class GoalOverlay implements GoalOverlayLike {
	private current: ActiveGoal | undefined;
	private list: GoalListItem[] = [];
	private headAdvances = 0;
	private flashObjective: string | undefined;
	private flashTimer: ReturnType<typeof setTimeout> | undefined;
	private refresh: (() => void) | undefined;

	/** No-op now — the CoreTaskStatusWidget owns the UI ctx. Kept for DI compat. */
	setUICtx(_ctx: ExtensionUIContext): void {}

	/** Register the composite's update as the refresh callback. */
	setRefresh(fn: () => void): void {
		this.refresh = fn;
	}

	/**
	 * Push the latest goal state. A new active goal supersedes any completion
	 * flash. `list` / `headAdvances` (when provided) refresh the queue suffix
	 * state; they persist across single-arg tick callers.
	 */
	update(goal: ActiveGoal | undefined, list?: GoalListItem[], headAdvances?: number): void {
		this.current = goal;
		if (list !== undefined) this.list = list;
		if (headAdvances !== undefined) this.headAdvances = headAdvances;
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
			// Loop 2 / Task 7: derive the queue suffix from the persisted list state.
			// total = head + tail; position is 1-based from headAdvances. Only
			// surfaced when total >= 2 (formatGoalOverlayLine enforces byte-identity
			// for bare /goal / 1-item lists regardless).
			const total = 1 + this.list.length;
			const queue =
				total >= 2
					? {
							position: this.headAdvances + 1,
							total,
							parked: this.list.filter((i) => i.parked).length,
					  }
					: undefined;
			return [formatGoalOverlayLine(this.current, theme, width, queue)];
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
