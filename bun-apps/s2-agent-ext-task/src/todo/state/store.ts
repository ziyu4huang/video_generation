import type { Task } from "../tool/types";
import { EMPTY_STATE, type TaskState } from "./state";

/**
 * Per-sessionId state isolation (optimization #3, ticket #16).
 *
 * State is partitioned by sessionId (`ctx.sessionManager.getSessionId()`, a
 * UUIDv7 — distinct between a parent session and an in-process subagent child
 * sharing the process). This fixes the ticket-#16 CAVEAT: previously a single
 * process-global cell meant an in-process subagent child calling the todo tool
 * mutated the PARENT's todos.
 *
 * THE renderSid TRICK: ToolRenderContext (renderCall/renderResult) and several
 * display paths (overlay, /todos command, status widget) have NO sessionManager,
 * so they cannot supply a sid. To minimize churn, no-arg accessors default to a
 * module-captured `renderSid` — the parent/display session id, set at parent
 * session_start. Thus display code keeps reading the parent's todos unchanged
 * (call sites untouched), while todo.ts execute threads the real ctx sid so a
 * child writes its own bucket and the parent writes its own.
 */
const DEFAULT_SID = "";
let renderSid: string = DEFAULT_SID;
const states = new Map<string, TaskState>();

function freshState(): TaskState {
	return { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}

function bucket(sid?: string): TaskState {
	const key = sid ?? renderSid; // no-arg → display (parent) bucket
	let s = states.get(key);
	if (!s) {
		s = freshState();
		states.set(key, s);
	}
	return s;
}

/** Capture the parent/display session id at session_start. No-arg accessors
 *  fall back to this bucket so ctx-less display code reads the parent's todos. */
export function setRenderSid(sid: string): void {
	renderSid = sid;
}

export function getState(sid?: string): TaskState {
	return bucket(sid);
}

export function replaceState(next: TaskState, sid?: string): void {
	states.set(sid ?? renderSid, next);
}

export function commitState(next: TaskState, sid?: string): void {
	states.set(sid ?? renderSid, next);
}

/** Test seam. No-arg: clear ALL buckets and reset renderSid (test clear-all).
 *  With an explicit sid: delete that single bucket (session_shutdown cleanup). */
export function __resetState(sid?: string): void {
	if (sid === undefined) {
		states.clear();
		renderSid = DEFAULT_SID;
	} else {
		states.delete(sid);
	}
}
