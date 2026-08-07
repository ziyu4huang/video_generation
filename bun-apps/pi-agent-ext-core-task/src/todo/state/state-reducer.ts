import type { Task, TaskAction, TaskMutationParams, TaskStatus } from "../tool/types";
import { isTransitionValid, validateReferentialIntegrity } from "./invariants";
import type { TaskState } from "./state";
import { detectCycle } from "./task-graph";

/**
 * Reducer outcome. Closed tagged union — adding a new action requires extending
 * this union AND the response-envelope's `formatContent` switch.
 */
export type Op =
	| { kind: "create"; taskId: number }
	| { kind: "update"; id: number; fromStatus: TaskStatus; toStatus: TaskStatus }
	| { kind: "delete"; id: number; subject: string; dependentsAffected?: number[] }
	| { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
	| { kind: "get"; task: Task }
	| { kind: "clear"; count: number }
	| { kind: "error"; message: string };

export interface ApplyResult {
	state: TaskState;
	op: Op;
}

function errorResult(state: TaskState, message: string): ApplyResult {
	return { state, op: { kind: "error", message } };
}

/**
 * Pure reducer: (state, action, params) → (state, op).
 */
export function applyTaskMutation(state: TaskState, action: TaskAction, params: TaskMutationParams): ApplyResult {
	switch (action) {
		case "create": {
			// Defense-in-depth: reject fields not honored by create
			if (params.status !== undefined) {
				return errorResult(state, "status is not accepted on create; tasks start as 'pending'");
			}
			if (params.id !== undefined) {
				return errorResult(state, "id is not accepted on create; id is auto-assigned");
			}
			if (params.addBlockedBy !== undefined || params.removeBlockedBy !== undefined) {
				return errorResult(state, "addBlockedBy/removeBlockedBy are not accepted on create; use blockedBy instead");
			}
			if (params.includeDeleted !== undefined) {
				return errorResult(state, "includeDeleted is not accepted on create; use it on list action");
			}

			if (!params.subject?.trim()) {
				return errorResult(state, "subject required for create");
			}
			if (params.blockedBy?.length) {
				for (const dep of params.blockedBy) {
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `blockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `blockedBy: #${dep} is deleted`);
				}
			}
			const newTask: Task = {
				id: state.nextId,
				subject: params.subject,
				status: "pending",
			};
			if (params.description) newTask.description = params.description;
			if (params.activeForm) newTask.activeForm = params.activeForm;
			if (params.blockedBy?.length) newTask.blockedBy = [...params.blockedBy];
			if (params.owner) newTask.owner = params.owner;
			if (params.metadata) newTask.metadata = { ...params.metadata };

			const newTasks = [...state.tasks, newTask];
			return {
				state: { tasks: newTasks, nextId: state.nextId + 1 },
				op: { kind: "create", taskId: newTask.id },
			};
		}

		case "update": {
			// Defense-in-depth: reject fields not honored by update
			if (params.blockedBy !== undefined) {
				return errorResult(state, "blockedBy is not accepted on update; use addBlockedBy/removeBlockedBy instead");
			}
			if (params.includeDeleted !== undefined) {
				return errorResult(state, "includeDeleted is not accepted on update; use it on list action");
			}

			if (params.id === undefined) return errorResult(state, "id required for update");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];

			const hasMutation =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.activeForm !== undefined ||
				params.status !== undefined ||
				params.owner !== undefined ||
				params.metadata !== undefined ||
				(params.addBlockedBy && params.addBlockedBy.length > 0) ||
				(params.removeBlockedBy && params.removeBlockedBy.length > 0);
			if (!hasMutation) return errorResult(state, "update requires at least one mutable field");

			let newStatus = current.status;
			if (params.status !== undefined) {
				if (!isTransitionValid(current.status, params.status)) {
					return errorResult(state, `illegal transition ${current.status} → ${params.status}`);
				}
				newStatus = params.status;
			}

			let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
			if (params.removeBlockedBy?.length) {
				const toRemove = new Set(params.removeBlockedBy);
				newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
			}
			if (params.addBlockedBy?.length) {
				for (const dep of params.addBlockedBy) {
					if (dep === current.id) return errorResult(state, `cannot block #${current.id} on itself`);
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) return errorResult(state, `addBlockedBy: #${dep} not found`);
					if (depTask.status === "deleted") return errorResult(state, `addBlockedBy: #${dep} is deleted`);
					if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
				}
				if (detectCycle(state.tasks, current.id, newBlockedBy)) {
					return errorResult(state, "addBlockedBy would create a cycle in the blockedBy graph");
				}
			}

			let newMetadata = current.metadata;
			if (params.metadata !== undefined) {
				const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
				for (const [k, v] of Object.entries(params.metadata)) {
					if (v === null) delete merged[k];
					else merged[k] = v;
				}
				newMetadata = Object.keys(merged).length ? merged : undefined;
			}

			const updated: Task = { ...current, status: newStatus };
			if (params.subject !== undefined) updated.subject = params.subject;
			if (params.description !== undefined) updated.description = params.description;
			if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
			if (params.owner !== undefined) updated.owner = params.owner;
			if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
			else delete updated.blockedBy;
			if (newMetadata === undefined) delete updated.metadata;
			else updated.metadata = newMetadata;

			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				op: { kind: "update", id: updated.id, fromStatus: current.status, toStatus: newStatus },
			};
		}

		case "list": {
			// Defense-in-depth: reject fields not honored by list
			const invalidFields: string[] = [];
			if (params.subject !== undefined) invalidFields.push("subject");
			if (params.description !== undefined) invalidFields.push("description");
			if (params.activeForm !== undefined) invalidFields.push("activeForm");
			if (params.blockedBy !== undefined) invalidFields.push("blockedBy");
			if (params.addBlockedBy !== undefined) invalidFields.push("addBlockedBy");
			if (params.removeBlockedBy !== undefined) invalidFields.push("removeBlockedBy");
			if (params.owner !== undefined) invalidFields.push("owner");
			if (params.metadata !== undefined) invalidFields.push("metadata");
			if (params.id !== undefined) invalidFields.push("id");
			if (invalidFields.length > 0) {
				return errorResult(state, `list action does not accept: ${invalidFields.join(", ")}`);
			}

			return {
				state,
				op: {
					kind: "list",
					includeDeleted: params.includeDeleted === true,
					...(params.status !== undefined ? { statusFilter: params.status } : {}),
				},
			};
		}

		case "get": {
			// Defense-in-depth: reject fields not honored by get
			const invalidFields: string[] = [];
			if (params.subject !== undefined) invalidFields.push("subject");
			if (params.description !== undefined) invalidFields.push("description");
			if (params.activeForm !== undefined) invalidFields.push("activeForm");
			if (params.status !== undefined) invalidFields.push("status");
			if (params.blockedBy !== undefined) invalidFields.push("blockedBy");
			if (params.addBlockedBy !== undefined) invalidFields.push("addBlockedBy");
			if (params.removeBlockedBy !== undefined) invalidFields.push("removeBlockedBy");
			if (params.owner !== undefined) invalidFields.push("owner");
			if (params.metadata !== undefined) invalidFields.push("metadata");
			if (params.includeDeleted !== undefined) invalidFields.push("includeDeleted");
			if (invalidFields.length > 0) {
				return errorResult(state, `get action does not accept: ${invalidFields.join(", ")}`);
			}

			if (params.id === undefined) return errorResult(state, "id required for get");
			const task = state.tasks.find((t) => t.id === params.id);
			if (!task) return errorResult(state, `#${params.id} not found`);
			return { state, op: { kind: "get", task } };
		}

		case "delete": {
			// Defense-in-depth: reject fields not honored by delete
			const invalidFields: string[] = [];
			if (params.subject !== undefined) invalidFields.push("subject");
			if (params.description !== undefined) invalidFields.push("description");
			if (params.activeForm !== undefined) invalidFields.push("activeForm");
			if (params.status !== undefined) invalidFields.push("status");
			if (params.blockedBy !== undefined) invalidFields.push("blockedBy");
			if (params.addBlockedBy !== undefined) invalidFields.push("addBlockedBy");
			if (params.removeBlockedBy !== undefined) invalidFields.push("removeBlockedBy");
			if (params.owner !== undefined) invalidFields.push("owner");
			if (params.metadata !== undefined) invalidFields.push("metadata");
			if (params.includeDeleted !== undefined) invalidFields.push("includeDeleted");
			if (invalidFields.length > 0) {
				return errorResult(state, `delete action does not accept: ${invalidFields.join(", ")}`);
			}

			if (params.id === undefined) return errorResult(state, "id required for delete");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];
			if (current.status === "deleted") return errorResult(state, `#${current.id} is already deleted`);

			// First mark the task as deleted
			const updated: Task = { ...current, status: "deleted" };
			const newTasks = [...state.tasks];
			newTasks[idx] = updated;

			// Then prune the deleted id from all other tasks' blockedBy arrays
			const { updatedTasks: prunedTasks, dependentsAffected } = validateReferentialIntegrity(
				newTasks,
				updated.id,
			);

			return {
				state: { tasks: prunedTasks, nextId: state.nextId },
				op: {
					kind: "delete",
					id: updated.id,
					subject: updated.subject,
					dependentsAffected: dependentsAffected.length > 0 ? dependentsAffected : undefined,
				},
			};
		}

		case "clear": {
			// Defense-in-depth: reject fields not honored by clear
			const invalidFields: string[] = [];
			if (params.subject !== undefined) invalidFields.push("subject");
			if (params.description !== undefined) invalidFields.push("description");
			if (params.activeForm !== undefined) invalidFields.push("activeForm");
			if (params.status !== undefined) invalidFields.push("status");
			if (params.blockedBy !== undefined) invalidFields.push("blockedBy");
			if (params.addBlockedBy !== undefined) invalidFields.push("addBlockedBy");
			if (params.removeBlockedBy !== undefined) invalidFields.push("removeBlockedBy");
			if (params.owner !== undefined) invalidFields.push("owner");
			if (params.metadata !== undefined) invalidFields.push("metadata");
			if (params.id !== undefined) invalidFields.push("id");
			if (params.includeDeleted !== undefined) invalidFields.push("includeDeleted");
			if (invalidFields.length > 0) {
				return errorResult(state, `clear action does not accept: ${invalidFields.join(", ")}`);
			}

			const count = state.tasks.length;
			return {
				state: { tasks: [], nextId: 1 },
				op: { kind: "clear", count },
			};
		}
	}
}
