import { type Static, Type } from "typebox";

// ---------------------------------------------------------------------------
// Inline StringEnum — stripped from @earendil-works/pi-ai dependency.
// Creates a string enum schema compatible with providers that don't support
// anyOf/const patterns.
// ---------------------------------------------------------------------------
function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
) {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values as never,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}

// ---------------------------------------------------------------------------
// Tool / command identity
// ---------------------------------------------------------------------------

export const TOOL_NAME = "todo";
export const TOOL_LABEL = "Todo";
export const COMMAND_NAME = "todos";

// ---------------------------------------------------------------------------
// User-facing strings
// ---------------------------------------------------------------------------

export const ERR_REQUIRES_INTERACTIVE = "/todos requires interactive mode";
export const MSG_NO_TODOS = "No todos yet. Ask the agent to add some!";

// ---------------------------------------------------------------------------
// Public domain types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

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

export interface TaskDetails {
	action: TaskAction;
	params: Record<string, unknown>;
	tasks: Task[];
	nextId: number;
	error?: string;
}

export interface TaskMutationParams {
	[key: string]: unknown;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TaskStatus;
	blockedBy?: number[];
	addBlockedBy?: number[];
	removeBlockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
	id?: number;
	includeDeleted?: boolean;
}

// ---------------------------------------------------------------------------
// TypeBox parameter schema — action-conditional fields
// ---------------------------------------------------------------------------

// Per-action field matrix (only fields actually honored by each action):
// - create:   subject*, description, activeForm, blockedBy, owner, metadata
// - update:   id*, subject, description, activeForm, status, addBlockedBy, removeBlockedBy, owner, metadata
// - list:     status, includeDeleted
// - get:      id*
// - delete:   id*
// - clear:    (no params)
//
// Fields marked * are required for that action.
//
// NOTE: blockedBy is NOT accepted on update (use addBlockedBy/removeBlockedBy instead).
// NOTE: status is NOT accepted on create (hardcoded to 'pending' by reducer).

// Flat single-object schema: `action` discriminates, every other field is
// optional, and the per-action matrix above is enforced by the reducer
// (state-reducer returns clear errors for wrong-action and missing-required
// fields — see the "reducer rejects …" test groups in __tests__/todo.test.ts).
//
// WHY NOT Type.Union at the root: TypeBox emits `{ anyOf: [...] }` with no
// top-level `type`, and OpenAI-compatible providers (z.ai GLM) reject any
// function schema whose root is not `type: "object"` — every request carrying
// this tool 400'd with "Invalid schema for function 'todo': … got 'type:
// null'". The flat form is provider-portable; strictness lives one layer down
// where it already existed.
export const TodoParamsSchema = Type.Object({
	action: StringEnum(["create", "update", "list", "get", "delete", "clear"] as const, {
		description: "Task action to perform",
	}),
	subject: Type.Optional(
		Type.String({ description: "Task subject line (required for create)" }),
	),
	id: Type.Optional(
		Type.Number({ description: "Task id (required for update, get, delete)" }),
	),
	description: Type.Optional(Type.String({ description: "Long-form task description (create, update)" })),
	activeForm: Type.Optional(
		Type.String({
			description: "Present-continuous spinner label shown while status is in_progress, e.g. 'writing tests' (create, update)",
		}),
	),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
			description: "update: target status to transition to. list: filter tasks by status",
		}),
	),
	includeDeleted: Type.Optional(
		Type.Boolean({
			description: "list only: if true, returns deleted (tombstoned) tasks as well. Default: false.",
		}),
	),
	blockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "create only: initial blockedBy ids (task ids this task depends on). NOT accepted on update — use addBlockedBy/removeBlockedBy",
		}),
	),
	addBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "update only: task ids to add to blockedBy (additive merge)",
		}),
	),
	removeBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "update only: task ids to remove from blockedBy (additive merge)",
		}),
	),
	owner: Type.Optional(Type.String({ description: "Agent/owner assigned to this task (create, update)" })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Arbitrary metadata (create, update); pass null value for a key to delete that key on update",
		}),
	),
});

export type TodoParams = Static<typeof TodoParamsSchema>;
