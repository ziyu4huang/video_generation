import type { Task } from "../tool/types";
import { EMPTY_STATE, type TaskState } from "./state";

/**
 * Process-global singleton. Safe because pi hosts one active AgentSession per
 * process (AgentSessionRuntime tears down the old session before creating the
 * next), so this cell maps 1:1 to the live session and session_start's
 * replaceState(EMPTY_STATE) reset is correct.
 *
 * CAVEAT: in-process subagents (WorkflowAgent.run -> createAgentSession,
 * pi-agent-ext-subagent) run a SECOND session in this same process and share
 * this cell. They do NOT fire session_start (they skip bindExtensions), so
 * there is no reset race, but a subagent that calls the todo tool reads/writes
 * the PARENT session's todos. See follow-up ticket #16 for the hardening fix.
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
