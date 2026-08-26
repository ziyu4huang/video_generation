/**
 * board-view — the TUI face's read adapter over the ONE shared task board
 * (cc-parity-task-powertool ticket 02/D7).
 *
 * The board itself lives in core-runtime's TeamTaskStore and is mutated ONLY
 * by ext-subagent's task_create/get/list/update tools (shared by the parent,
 * spawn children, and workflow agents). This module derives the render
 * snapshot the overlay, /todos command, and selectors consume:
 *
 * - string board ids → the numeric ids the view layer has always used;
 * - blockedBy → EFFECTIVE deps only (completed deps are cleared — CC's
 *   blocked-until-resolved semantics, same selector the task tools render
 *   with, so the model's list and the user's widget never disagree).
 */
import { effectiveBlockedBy, getTeamTaskStore, type TeamTask } from "@repo/s2-agent-core-runtime";
import type { Task, TaskState } from "./types";

/** The scope the task tools address (one parent session per process). */
const BOARD_SESSION_ID = "*";

function toViewTask(t: TeamTask, board: TeamTask[]): Task {
	const blockedBy = effectiveBlockedBy(board, t).map(Number);
	return {
		id: Number(t.id),
		subject: t.subject,
		...(t.description ? { description: t.description } : {}),
		...(t.activeForm ? { activeForm: t.activeForm } : {}),
		status: t.status,
		...(blockedBy.length ? { blockedBy } : {}),
		...(t.owner ? { owner: t.owner } : {}),
		...(t.metadata ? { metadata: t.metadata } : {}),
	};
}

/** Current render snapshot of the shared board (never empty-objects — an
 *  empty board renders no widget section, same as before). */
export function getBoardViewState(): TaskState {
	const board = getTeamTaskStore().list(BOARD_SESSION_ID);
	return {
		tasks: board.map((t) => toViewTask(t, board)),
		nextId: board.reduce((max, t) => Math.max(max, Number(t.id)), 0) + 1,
	};
}
