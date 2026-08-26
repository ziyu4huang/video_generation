/**
 * /todos command — the TUI face of the ONE shared task board
 * (cc-parity-task-powertool ticket 02/D7).
 *
 * The `todo` mega-tool is retired: the model-visible task family is
 * ext-subagent's core-gated task_create/get/list/update over core-runtime's
 * TeamTaskStore, and this package only RENDERS that board (this command +
 * the composite-widget section in overlay.ts). Reads go through
 * ../board-view.ts (effective blockedBy only — completed deps render
 * cleared, same as the task tools' list output).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBoardViewState } from "./board-view";
import { selectTasksByStatus, selectTodoCounts, selectVisibleTasks } from "./state/selectors";
import { COMMAND_NAME, ERR_REQUIRES_INTERACTIVE, MSG_NO_TODOS } from "./types";
import { formatCommandTaskLine, formatStatusLabel } from "./view/format";

// ---------------------------------------------------------------------------
// /todos slash command
// ---------------------------------------------------------------------------

export function registerTodosCommand(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Show all todos on the current branch, grouped by status",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(ERR_REQUIRES_INTERACTIVE, "error");
				return;
			}
			const state = getBoardViewState();
			const visible = selectVisibleTasks(state);
			if (visible.length === 0) {
				ctx.ui.notify(MSG_NO_TODOS, "info");
				return;
			}
			const groups = selectTasksByStatus(state);
			const counts = selectTodoCounts(state);

			const header: string[] = [];
			if (counts.completed > 0) header.push(`${counts.completed}/${counts.total} ${formatStatusLabel("completed")}`);
			if (counts.inProgress > 0) header.push(`${counts.inProgress} ${formatStatusLabel("in_progress")}`);
			if (counts.pending > 0) header.push(`${counts.pending} ${formatStatusLabel("pending")}`);

			const lines: string[] = [header.join(" · ")];
			if (groups.pending.length > 0) {
				lines.push("── Pending ──");
				for (const task of groups.pending) lines.push(formatCommandTaskLine(task, "○"));
			}
			if (groups.inProgress.length > 0) {
				lines.push("── In Progress ──");
				for (const task of groups.inProgress) lines.push(formatCommandTaskLine(task, "◐"));
			}
			if (groups.completed.length > 0) {
				lines.push("── Completed ──");
				for (const task of groups.completed) lines.push(formatCommandTaskLine(task, "✓"));
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
