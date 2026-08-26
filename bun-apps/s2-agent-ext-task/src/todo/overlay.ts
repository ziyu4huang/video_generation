/**
 * todo/overlay.ts — todo section renderer for the CoreTaskStatusWidget.
 *
 * Refactored for overlay unification: no longer owns a `setWidget` lifecycle.
 * The CoreTaskStatusWidget (shared/status-widget.ts) owns the single
 * below-editor widget key and renders this section alongside the goal section
 * in a fixed order. TodoOverlay is now a state-holder that exposes
 * `render(theme, width)` and pokes `refresh()` (the composite's update) when
 * its content changes.
 *
 * Since cc-parity-task-powertool ticket 02/D7 the rendered STATE is the ONE
 * shared task board (core-runtime's TeamTaskStore, mutated by ext-subagent's
 * task_* tools), read through ../board-view.ts — this overlay renders what
 * the model's task_list shows, effective blockedBy included.
 *
 * Stripped of external i18n dependency (@juicesharp/rpiv-i18n):
 * - formatStatusLabel imported from sister module (view/format.ts — English-only inline)
 * - All t(key, fallback) calls replaced with fallback literals
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { getBoardViewState } from "./board-view";
import { formatStatusLabel, formatOverlayTaskLine } from "./view/format";
import { selectHasActive, selectOverlayLayout, selectShowTaskIds, selectTodoCounts } from "./state/selectors";
import type { Task } from "./types";

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

	/** Debug snapshot for inspect_tui — exposes the hidden/display state that
	 *  drives the render but isn't visible in the TUI output. */
	inspect(): {
		totalTasks: number;
		visibleTasks: number;
		hiddenCompletedTaskIds: number[];
		pendingHideIds: number[];
		fullTaskList: { id: number; subject: string; status: string }[];
	} {
		const state = getBoardViewState();
		return {
			totalTasks: state.tasks.length,
			visibleTasks: state.tasks.filter((t) => !this.shouldHideCompletedTask(t)).length,
			hiddenCompletedTaskIds: [...this.hiddenCompletedTaskIds],
			pendingHideIds: [...this.completedTaskIdsPendingHide],
			fullTaskList: state.tasks.map((t) => ({ id: t.id, subject: t.subject, status: t.status })),
		};
	}

	private getSnapshot() {
		const state = getBoardViewState();
		// A shrinking nextId means the board was reset (session_start) — the
		// hide-completed display state belongs to the previous board.
		if (this.lastNextId !== undefined && state.nextId < this.lastNextId) {
			this.resetCompletedDisplayState();
		}
		this.lastNextId = state.nextId;
		const completedTaskIds = new Set(state.tasks.filter((task) => task.status === "completed").map((task) => task.id));
		for (const taskId of this.completedTaskIdsPendingHide) {
			if (!completedTaskIds.has(taskId)) this.completedTaskIdsPendingHide.delete(taskId);
		}
		for (const taskId of this.hiddenCompletedTaskIds) {
			if (!completedTaskIds.has(taskId)) this.hiddenCompletedTaskIds.delete(taskId);
		}
		return state;
	}

	private selectOverlayTasks(snapshot: ReturnType<TodoOverlay["getSnapshot"]>) {
		return snapshot.tasks.filter((task) => !this.shouldHideCompletedTask(task));
	}

	private shouldHideCompletedTask(task: Task): boolean {
		return task.status === "completed" && this.hiddenCompletedTaskIds.has(task.id);
	}

	/** Render the todo section lines (heading + visible tasks + overflow). Empty if no tasks. */
	render(theme: Theme, width: number): string[] {
		const snapshot = this.getSnapshot();
		const overlayTasks = this.selectOverlayTasks(snapshot);

		const truncate = (line: string): string => truncateToWidth(line, width, "…");
		// Heading counts reflect REAL progress over ALL tasks, not just the
		// visible subset. Completed tasks are hidden from the list after
		// agent_start but must still count — otherwise the heading shows "0/2"
		// when 7 tasks are completed+hidden, looking like nothing was done.
		const counts = selectTodoCounts(snapshot);

		// M6 fix: Only return empty if there are NO tasks at all. If there are tasks
		// but all are completed/hidden, we still show the heading with counts.
		if (counts.total === 0) return [];

		const hasActive = selectHasActive(snapshot);
		const showIds = selectShowTaskIds(snapshot);

		const headingColor = hasActive ? "accent" : "dim";
		const headingIcon = hasActive ? "●" : "○";
		const headingText = `Todos (${counts.completed}/${counts.total})`;
		const heading = truncate(`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, headingText)}`);

		const lines: string[] = [heading];
		const layout = selectOverlayLayout({ tasks: overlayTasks, nextId: snapshot.nextId }, MAX_WIDGET_LINES - 1);
		let lastTask: (typeof layout.visible)[number] | undefined;
		for (const task of layout.visible) {
			lines.push(truncate(`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, showIds)}`));
			lastTask = task;
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
			// Rebuild the last line structurally with └─ instead of ├─ to avoid
			// clobbering a subject that contains the literal string.
			if (lastTask) {
				const last = lines.length - 1;
				lines[last] = truncate(`${theme.fg("dim", "└─")} ${formatOverlayTaskLine(lastTask, theme, showIds)}`);
			}
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
