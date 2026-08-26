/**
 * View-shape types for the todo TUI face (cc-parity-task-powertool ticket
 * 02/D7: the `todo` mega-tool is retired; the ONE model-visible task family
 * is ext-subagent's core-gated task_create/get/list/update over
 * core-runtime's TeamTaskStore). These types describe what the overlay,
 * /todos command, and selectors render — derived from the board by
 * ../board-view.ts, never mutated locally.
 */

export type TaskStatus = "pending" | "in_progress" | "completed";

/** One board task in the render shape (numeric ids; effective blockedBy only). */
export interface Task {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
}

/** Snapshot the view layer consumes (kept for selector/overlay compatibility). */
export interface TaskState {
	tasks: Task[];
	nextId: number;
}

// ---------------------------------------------------------------------------
// /todos command strings
// ---------------------------------------------------------------------------

export const COMMAND_NAME = "todos";

export const ERR_REQUIRES_INTERACTIVE = "/todos requires interactive mode";

export const MSG_NO_TODOS = "No todos yet. Ask the agent to add some!";
