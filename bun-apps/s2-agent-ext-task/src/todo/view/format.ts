/**
 * View formatters for the todo TUI face (board overlay + /todos command).
 *
 * Stripped of external i18n dependency (@juicesharp/rpiv-i18n):
 * - formatStatusLabel inlined (English-only)
 * - All t(key, fallback) calls replaced with fallback literals
 *
 * The mega-tool render hooks (renderTodoCall/renderTodoResult) were removed
 * with the tool itself (cc-parity-task-powertool ticket 02/D7) — ext-subagent
 * owns the model-visible task tools now.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Task, TaskStatus } from "../types";

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
	}
}

export function overlayStatusGlyph(status: TaskStatus, theme: Theme): string {
	switch (status) {
		case "pending":
			return theme.fg("dim", "○");
		case "in_progress":
			return theme.fg("warning", "◐");
		case "completed":
			return theme.fg("success", "✓");
	}
}

export function formatOverlayTaskLine(t: Task, theme: Theme, showId: boolean): string {
	const glyph = overlayStatusGlyph(t.status, theme);
	const subjectColor = t.status === "completed" ? "dim" : "text";
	let subject = theme.fg(subjectColor, t.subject);
	if (t.status === "completed") {
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
	// blockedBy arrives pre-filtered to EFFECTIVE deps (board-view) — a
	// completed dependency never renders ⛓ here.
	const block = t.blockedBy?.length ? `    ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	// Truncate subject to keep /todos output bounded
	const maxSubjectWidth = 60;
	const truncatedSubject = t.subject.length > maxSubjectWidth ? truncateToWidth(t.subject, maxSubjectWidth, "…") : t.subject;
	return `  ${glyph} #${t.id} ${truncatedSubject}${form}${block}`;
}
