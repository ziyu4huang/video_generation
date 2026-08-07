import type { TaskStatus } from "../tool/types";
import type { Task } from "../tool/types";

/**
 * Allowed forward transitions per source status. `completed` is one-way to
 * `deleted` (never back to `in_progress`); `deleted` is terminal.
 *
 * Idempotent same→same is checked separately in `isTransitionValid` so this
 * table only enumerates actual transitions.
 */
export const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
	pending: new Set(["in_progress", "completed", "deleted"]),
	in_progress: new Set(["pending", "completed", "deleted"]),
	completed: new Set(["deleted"]),
	deleted: new Set(),
};

export function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
	if (from === to) return true;
	return VALID_TRANSITIONS[from].has(to);
}

/**
 * Result of a referential integrity prune operation.
 */
export interface ReferentialIntegrityResult {
	/** Updated tasks with the deleted id removed from all blockedBy arrays. */
	updatedTasks: Task[];
	/** IDs of tasks whose blockedBy was pruned (dependents affected). */
	dependentsAffected: number[];
}

/**
 * Prunes a deleted task's id from all other tasks' blockedBy arrays.
 *
 * This maintains referential integrity: when task B is deleted, any task A
 * that has B in its blockedBy should have B removed. Otherwise, A shows a
 * stale dependency glyph (⛓ #B) in the overlay.
 *
 * @param tasks - Current task set (may include the deleted task itself)
 * @param deletedId - ID of the task being deleted
 * @returns Updated tasks and list of dependent task IDs that were affected
 */
export function validateReferentialIntegrity(tasks: Task[], deletedId: number): ReferentialIntegrityResult {
	const dependentsAffected: number[] = [];
	const updatedTasks = tasks.map((task) => {
		// Skip the deleted task itself (it's already marked deleted by the reducer)
		if (task.id === deletedId) {
			return task;
		}

		// If this task has no blockedBy, nothing to do
		if (!task.blockedBy || task.blockedBy.length === 0) {
			return task;
		}

		// Check if the deleted id is in this task's blockedBy
		if (!task.blockedBy.includes(deletedId)) {
			return task;
		}

		// Remove the deleted id from blockedBy
		const newBlockedBy = task.blockedBy.filter((id) => id !== deletedId);
		dependentsAffected.push(task.id);

		// Return updated task (drop blockedBy field if empty)
		if (newBlockedBy.length === 0) {
			const { blockedBy, ...rest } = task;
			return rest;
		}

		return { ...task, blockedBy: newBlockedBy };
	});

	return { updatedTasks, dependentsAffected };
}
