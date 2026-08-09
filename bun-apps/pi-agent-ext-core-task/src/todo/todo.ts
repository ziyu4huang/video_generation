/**
 * todo tool + /todos command — thin registration shell.
 *
 * Stripped of external dependencies (rpiv-config, rpiv-i18n):
 * - promptSnippet/guidelines removed (stealth — description routes; system-prompt saving)
 * - i18n-bridge replaced with English-only inline calls
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { selectTasksByStatus, selectTodoCounts, selectVisibleTasks } from "./state/selectors";
import { applyTaskMutation } from "./state/state-reducer";
import { commitState, getState, replaceState } from "./state/store";
import { buildToolResult } from "./tool/response-envelope";
import {
	COMMAND_NAME,
	ERR_REQUIRES_INTERACTIVE,
	MSG_NO_TODOS,
	type TaskMutationParams,
	TOOL_LABEL,
	TOOL_NAME,
	TodoParamsSchema,
} from "./tool/types";
import { formatCommandTaskLine, formatStatusLabel, renderTodoCall, renderTodoResult } from "./view/format";

// ---------------------------------------------------------------------------
// Inlined config defaults — stripped from @juicesharp/rpiv-config
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerTodoTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TOOL_NAME,
		gating: { core: true },
		label: TOOL_LABEL,
		description:
			"Manage a task list for tracking multi-step progress. Actions: create (new task), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.",
		parameters: TodoParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// Thread the real ctx sessionId so an in-process subagent child writes its
			// own bucket rather than the parent's (renderCall/renderResult/command stay
			// no-arg → renderSid/parent bucket; they render the parent TUI). Ticket #16.
			const sid = _ctx?.sessionManager?.getSessionId();
			const result = applyTaskMutation(getState(sid), params.action, params as TaskMutationParams);
			commitState(result.state, sid);
			return buildToolResult(params.action, params as TaskMutationParams, result.state, result.op);
		},

		renderCall(args, theme, _context) {
			return renderTodoCall(args as never, theme, getState());
		},

		renderResult(result, _opts, theme, _context) {
			return renderTodoResult(result, theme);
		},
	});
}

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
			const state = getState();
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
