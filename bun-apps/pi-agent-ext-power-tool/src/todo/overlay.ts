/**
 * todo/overlay.ts — todo section renderer for the PowerToolStatusWidget.
 *
 * Refactored for overlay unification: no longer owns a `setWidget` lifecycle.
 * The PowerToolStatusWidget (shared/status-widget.ts) owns the single
 * above-editor widget key and renders this section alongside the goal section
 * in a fixed order. TodoOverlay is now a state-holder that exposes
 * `render(theme, width)` and pokes `refresh()` (the composite's update) when
 * its content changes.
 *
 * Stripped of external i18n dependency (@juicesharp/rpiv-i18n):
 * - formatStatusLabel imported from sister module (view/format.ts — English-only inline)
 * - All t(key, fallback) calls replaced with fallback literals
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatStatusLabel } from "./view/format";
import { selectHasActive, selectOverlayLayout, selectShowTaskIds, selectTodoCounts } from "./state/selectors";
import { getState } from "./state/store";
import { formatOverlayTaskLine } from "./view/format";

const MAX_WIDGET_LINES = 12;

export class TodoOverlay {
	private refresh: (() => void) | undefined;
	private completedTaskIdsPendingHide = new Set<number>();
	private hiddenCompletedTaskIds = new Set<number>();
	private lastNextId: number | undefined;

	/** Register the composite's update as the refresh callback. */
	setRefresh(fn: () => void): void {
		this.refresh = fn;
	}

	/** Re-render via the composite. Call after any state change. */
	update(): void {
		this.refresh?.();
	}

	resetCompletedDisplayState(): void {
		this.completedTaskIdsPendingHide.clear();
		this.hiddenCompletedTaskIds.clear();
		this.lastNextId = undefined;
		this.refresh?.();
	}

	hideCompletedTasksFromPreviousTurn(): void {
		if (this.completedTaskIdsPendingHide.size === 0) return;
		for (const taskId of this.completedTaskIdsPendingHide) {
			this.hiddenCompletedTaskIds.add(taskId);
		}
		this.completedTaskIdsPendingHide.clear();
		this.refresh?.();
	}

	dispose(): void {
		this.resetCompletedDisplayState();
	}

	private getSnapshot() {
		const state = getState();
		if (this.lastNextId !== undefined && state.nextId < this.lastNextId) {
			this.resetCompletedDisplayState();
		}
		this.lastNextId = state.nextId;
		const completedTaskIds = new Set(
			state.tasks.filter((task) => task.status === "completed").map((task) => task.id),
		);
		for (const taskId of this.completedTaskIdsPendingHide) {
			if (!completedTaskIds.has(taskId)) this.completedTaskIdsPendingHide.delete(taskId);
		}
		for (const taskId of this.hiddenCompletedTaskIds) {
			if (!completedTaskIds.has(taskId)) this.hiddenCompletedTaskIds.delete(taskId);
		}
		return { tasks: [...state.tasks], nextId: state.nextId };
	}

	private selectOverlayTasks(snapshot: ReturnType<TodoOverlay["getSnapshot"]>) {
		return snapshot.tasks.filter((task) => task.status !== "deleted" && !this.shouldHideCompletedTask(task));
	}

	private shouldHideCompletedTask(task: ReturnType<TodoOverlay["getSnapshot"]>["tasks"][number]): boolean {
		return task.status === "completed" && this.hiddenCompletedTaskIds.has(task.id);
	}

	/** Render the todo section lines (heading + visible tasks + overflow). Empty if no tasks. */
	render(theme: Theme, width: number): string[] {
		const snapshot = this.getSnapshot();
		const overlayTasks = this.selectOverlayTasks(snapshot);
		if (overlayTasks.length === 0) return [];

		const overlayState = { tasks: overlayTasks, nextId: snapshot.nextId };
		const truncate = (line: string): string => truncateToWidth(line, width, "…");
		const counts = selectTodoCounts(overlayState);
		const hasActive = selectHasActive(overlayState);
		const showIds = selectShowTaskIds(overlayState);

		const headingColor = hasActive ? "accent" : "dim";
		const headingIcon = hasActive ? "●" : "○";
		const headingText = `Todos (${counts.completed}/${counts.total})`;
		const heading = truncate(`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, headingText)}`);

		const lines: string[] = [heading];
		const layout = selectOverlayLayout(overlayState, MAX_WIDGET_LINES - 1);
		for (const task of layout.visible) {
			lines.push(truncate(`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds)}`));
		}

		const newlyDisplayedCompletedTaskIds = overlayTasks
			.filter(
				(task) =>
					task.status === "completed" &&
					!this.completedTaskIdsPendingHide.has(task.id) &&
					!this.hiddenCompletedTaskIds.has(task.id),
			)
			.map((task) => task.id);
		for (const taskId of newlyDisplayedCompletedTaskIds) {
			this.completedTaskIdsPendingHide.add(taskId);
		}

		if (layout.hiddenCompleted === 0 && layout.truncatedTail === 0) {
			const last = lines.length - 1;
			lines[last] = lines[last].replace("├─", "└─");
			return lines;
		}

		const totalHidden = layout.hiddenCompleted + layout.truncatedTail;
		const overflowParts: string[] = [];
		if (layout.hiddenCompleted > 0) overflowParts.push(`${layout.hiddenCompleted} ${formatStatusLabel("completed")}`);
		if (layout.truncatedTail > 0) overflowParts.push(`${layout.truncatedTail} ${formatStatusLabel("pending")}`);
		const summary = overflowParts.length > 0 ? `+${totalHidden} more (${overflowParts.join(", ")})` : `+${totalHidden} more`;
		lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", summary)}`));
		return lines;
	}
}
