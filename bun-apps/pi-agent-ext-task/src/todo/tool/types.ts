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

// Base shared fields
const CommonFields = {
	action: StringEnum(["create", "update", "list", "get", "delete", "clear"] as const),
} as const;

const OptionalFields = {
	description: Type.Optional(Type.String({ description: "Long-form task description" })),
	activeForm: Type.Optional(
		Type.String({
			description: "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')",
		}),
	),
	owner: Type.Optional(Type.String({ description: "Agent/owner assigned to this task" })),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "Arbitrary metadata; pass null value for a key to delete that key on update",
		}),
	),
} as const;

// Action-specific schemas
const CreateParamsSchema = Type.Object({
	...CommonFields,
	action: Type.Literal("create"),
	subject: Type.String({ description: "Task subject line (required)" }),
	...OptionalFields,
	blockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Initial blockedBy ids (task ids this task depends on)",
		}),
	),
});

const UpdateParamsSchema = Type.Object({
	...CommonFields,
	action: Type.Literal("update"),
	id: Type.Number({ description: "Task id (required)" }),
	subject: Type.Optional(Type.String({ description: "Task subject line" })),
	...OptionalFields,
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
			description: "Target status to transition to",
		}),
	),
	addBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Task ids to add to blockedBy (additive merge)",
		}),
	),
	removeBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Task ids to remove from blockedBy (additive merge)",
		}),
	),
});

const ListParamsSchema = Type.Object({
	...CommonFields,
	action: Type.Literal("list"),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
			description: "Filter tasks by status",
		}),
	),
	includeDeleted: Type.Optional(
		Type.Boolean({
			description: "If true, returns deleted (tombstoned) tasks as well. Default: false.",
		}),
	),
});

const GetParamsSchema = Type.Object({
	...CommonFields,
	action: Type.Literal("get"),
	id: Type.Number({ description: "Task id (required)" }),
});

const DeleteParamsSchema = Type.Object({
	...CommonFields,
	action: Type.Literal("delete"),
	id: Type.Number({ description: "Task id (required)" }),
});

const ClearParamsSchema = Type.Object({
	...CommonFields,
	action: Type.Literal("clear"),
});

// Discriminated union: one schema per action
export const TodoParamsSchema = Type.Union([
	CreateParamsSchema,
	UpdateParamsSchema,
	ListParamsSchema,
	GetParamsSchema,
	DeleteParamsSchema,
	ClearParamsSchema,
]);

export type TodoParams = Static<typeof TodoParamsSchema>;
