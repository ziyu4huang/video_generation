import type { Task } from "../tool/types";

/**
 * Canonical state for the todo tool. Single source of truth — both the reducer
 * and the live store cell read this shape.
 */
export interface TaskState {
	tasks: Task[];
	nextId: number;
}

export const EMPTY_STATE: TaskState = Object.freeze({ tasks: Object.freeze([]) as unknown as Task[], nextId: 1 });
