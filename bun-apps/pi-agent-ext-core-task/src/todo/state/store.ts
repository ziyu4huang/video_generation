import type { Task } from "../tool/types";
import { EMPTY_STATE, type TaskState } from "./state";

/**
 * Module-level live state cell. Centralized mutation seam — only commitState
 * and replaceState modify it.
 */
let state: TaskState = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };

export function getTodos(): readonly Task[] {
	return state.tasks;
}

export function getNextId(): number {
	return state.nextId;
}

export function getState(): TaskState {
	return state;
}

export function replaceState(next: TaskState): void {
	state = next;
}

export function commitState(next: TaskState): void {
	state = next;
}

export function __resetState(): void {
	state = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}
