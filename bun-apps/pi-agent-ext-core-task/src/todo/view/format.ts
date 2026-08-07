/**
 * View formatters for the todo tool.
 *
 * Stripped of external i18n dependency (@juicesharp/rpiv-i18n):
 * - formatStatusLabel inlined (English-only, 3-line switch)
 * - All t(key, fallback) calls replaced with fallback literals
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { selectTaskSubjectById } from "../state/selectors";
import type { TaskState } from "../state/state";
import type { Task, TaskAction, TaskDetails, TaskMutationParams, TaskStatus } from "../tool/types";

// ---------------------------------------------------------------------------
// Inlined formatStatusLabel — English only, no i18n dependency
// ---------------------------------------------------------------------------

export function formatStatusLabel(status: TaskStatus): string {
	switch (status) {
		case "pending":
			return "pending";
		case "in_progress":
			return "in progress";
		case "completed":
			return "completed";
		case "deleted":
			return "deleted";
	}
}

// ---------------------------------------------------------------------------
// Status presentation tables
// ---------------------------------------------------------------------------

export const STATUS_GLYPH: Record<TaskStatus, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "●",
	deleted: "⊘",
};

export const STATUS_COLOR: Record<TaskStatus, "dim" | "warning" | "success" | "muted"> = {
	pending: "dim",
	in_progress: "warning",
	completed: "success",
	deleted: "muted",
};

export const ACTION_GLYPH: Record<TaskAction, string> = {
	create: "+",
	update: "→",
	delete: "×",
	get: "›",
	list: "☰",
	clear: "∅",
};

export function overlayStatusGlyph(status: TaskStatus, theme: Theme): string {
	switch (status) {
		case "pending":
			return theme.fg("dim", "○");
		case "in_progress":
			return theme.fg("warning", "◐");
		case "completed":
			return theme.fg("success", "✓");
		case "deleted":
			return theme.fg("error", "✗");
	}
}

export function formatOverlayTaskLine(t: Task, theme: Theme, showId: boolean): string {
	const glyph = overlayStatusGlyph(t.status, theme);
	const subjectColor = t.status === "completed" || t.status === "deleted" ? "dim" : "text";
	let subject = theme.fg(subjectColor, t.subject);
	if (t.status === "completed" || t.status === "deleted") {
		subject = theme.strikethrough(subject);
	}
	let line = `${glyph}`;
	if (showId) line += ` ${theme.fg("accent", `#${t.id}`)}`;
	line += ` ${subject}`;
	if (t.status === "in_progress" && t.activeForm) {
		line += ` ${theme.fg("dim", `(${t.activeForm})`)}`;
	}
	if (t.blockedBy && t.blockedBy.length > 0) {
		line += ` ${theme.fg("dim", `⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`)}`;
	}
	return line;
}

export function formatCommandTaskLine(t: Task, glyph: string): string {
	const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
	const block = t.blockedBy?.length ? `    ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	// Truncate subject to keep /todos output bounded
	const maxSubjectWidth = 60;
	const truncatedSubject = t.subject.length > maxSubjectWidth ? truncateToWidth(t.subject, maxSubjectWidth, "…") : t.subject;
	return `  ${glyph} #${t.id} ${truncatedSubject}${form}${block}`;
}

// ---------------------------------------------------------------------------
// Tool render hooks
// ---------------------------------------------------------------------------

export function renderTodoCall(
	args: TaskMutationParams & { action: TaskAction },
	theme: Theme,
	state: TaskState,
): Text {
	const glyph = ACTION_GLYPH[args.action] ?? args.action;
	let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", glyph);

	if (args.action === "create" && args.subject) {
		text += ` ${theme.fg("dim", args.subject)}`;
	} else if (
		(args.action === "update" || args.action === "get" || args.action === "delete") &&
		args.id !== undefined
	) {
		const subject = selectTaskSubjectById(state, args.id);
		text += ` ${theme.fg("accent", subject ?? `#${args.id}`)}`;
	} else if (args.action === "list" && args.status) {
		text += ` ${theme.fg("muted", formatStatusLabel(args.status))}`;
	}
	return new Text(text, 0, 0);
}

export function renderTodoResult(result: { details?: unknown }, theme: Theme): Text {
	const details = result.details as TaskDetails | undefined;

	// M4 fix: Check error first and render failure indicator before any success glyph
	if (details?.error) {
		return new Text(theme.fg("error", `✗ Error: ${details.error}`), 0, 0);
	}

	let status: TaskStatus | undefined;
	if (details) {
		const params = details.params as TaskMutationParams;
		switch (details.action) {
			case "create":
				status = details.tasks[details.tasks.length - 1]?.status;
				break;
			case "update":
				status = params.status ?? details.tasks.find((t) => t.id === params.id)?.status;
				break;
			case "delete":
				status = details.tasks.find((t) => t.id === params.id)?.status;
				break;
			case "list":
			case "get":
			case "clear":
				break;
		}
	}
	if (status) {
		return new Text(theme.fg(STATUS_COLOR[status], `${STATUS_GLYPH[status]} ${formatStatusLabel(status)}`), 0, 0);
	}
	return new Text(theme.fg("success", "✓"), 0, 0);
}
