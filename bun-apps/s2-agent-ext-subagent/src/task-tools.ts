/**
 * `task_create` / `task_get` / `task_list` / `task_update` — the shared team
 * task board (agent-teams parity ticket 03, effort
 * `.planning/2026-08-22-subagent-teams-parity`).
 *
 * Thin adapters, nothing more: every rule (id allocation, edge symmetry, cycle
 * rejection, owner validation, board lifecycle) lives in core-runtime's
 * TeamTaskStore; these tools only shape schemas and render results. The board
 * is session-scoped and in-memory — deliberately NOT ext-task's todo tracker
 * (that is a single session's private scratchpad; this one is shared by the
 * parent, spawn children, and workflow agents through the ONE store singleton).
 *
 * The tools register in the parent and reach children through the existing
 * `extensionTools` bridges — zero dispatch-path changes (map D9). Read-only
 * children keep them: they are not in READ_ONLY_EXCLUDED (a task update mutates
 * the team BOARD, never the filesystem).
 */
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  getTeamTaskStore,
  isTeamTaskError,
  type TeamTask,
  type TeamTaskStatus,
  type TeamTaskStore,
} from "@repo/s2-agent-core-runtime";
import { Type } from "typebox";

/** The scope the tools address when the host has no parent-session token (one parent session per process). */
export const TASK_BOARD_SESSION_ID = "*";

const statusSchema = Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
  description: "pending | in_progress | completed",
});

export const taskCreateSchema = Type.Object({
  subject: Type.String({ description: "Short imperative title, e.g. 'Add retry tests'." }),
  description: Type.Optional(Type.String({ description: "What needs to be done and why (defaults to '')." })),
  activeForm: Type.Optional(
    Type.String({ description: 'Present-continuous label shown while in_progress, e.g. "Adding retry tests".' }),
  ),
  owner: Type.Optional(
    Type.String({ description: 'Claim immediately: your live-agent name or "main". Leave unset for an unowned task.' }),
  ),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Unknown({ description: "Arbitrary JSON attachments (PR ids, file paths, …)." })),
  ),
  blockedBy: Type.Optional(
    Type.Array(Type.String(), { description: "Task ids this task must wait on (validated: must exist, no cycles)." }),
  ),
  blocks: Type.Optional(
    Type.Array(Type.String(), { description: "Task ids this task blocks (the symmetric side of blockedBy)." }),
  ),
});

export const taskGetSchema = Type.Object({
  id: Type.String({ description: 'Task id from task_create / task_list (e.g. "2").' }),
});

export const taskListSchema = Type.Object({
  status: Type.Optional(statusSchema),
  owner: Type.Optional(Type.String({ description: 'Filter by owner (a live-agent name or "main").' })),
});

export const taskUpdateSchema = Type.Object({
  id: Type.String({ description: "Task id to update." }),
  subject: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  activeForm: Type.Optional(
    Type.Union([Type.String(), Type.Null()], { description: "Set or clear (null) the present-continuous label." }),
  ),
  status: Type.Optional(statusSchema),
  owner: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description: 'Claim / re-assign (live-agent name or "main"); null releases the claim.',
    }),
  ),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Dependency ids to add (cycle-checked)." })),
  removeBlockedBy: Type.Optional(Type.Array(Type.String())),
  addBlocks: Type.Optional(
    Type.Array(Type.String(), { description: "Ids this task starts blocking (cycle-checked)." }),
  ),
  removeBlocks: Type.Optional(Type.Array(Type.String())),
});

export interface TaskToolsOptions {
  /** Store to back the tools. Defaults to the core-runtime process singleton. */
  store?: TeamTaskStore;
  /** Parent-session key the tools address. Defaults to the "*" single-parent scope. */
  getSessionId?: () => string;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

/** One compact board line: `#2 [in_progress] owner=researcher — Add retry tests (blockedBy: 1)`. */
function taskLine(t: TeamTask): string {
  const owner = t.owner ? ` owner=${t.owner}` : "";
  const edges = [
    ...(t.blockedBy.length ? [`blockedBy: ${t.blockedBy.join(",")}`] : []),
    ...(t.blocks.length ? [`blocks: ${t.blocks.join(",")}`] : []),
  ];
  const edgeNote = edges.length ? ` (${edges.join("; ")})` : "";
  return `#${t.id} [${t.status}]${owner} — ${t.subject}${edgeNote}`;
}

function boardSummary(tasks: TeamTask[]): string {
  const byStatus = (s: TeamTaskStatus) => tasks.filter((t) => t.status === s).length;
  return `${tasks.length} task(s): ${byStatus("pending")} pending, ${byStatus("in_progress")} in_progress, ${byStatus("completed")} completed`;
}

function errorText(err: { error: string }, hint: string): string {
  return `${err.error}. ${hint}`;
}

/**
 * The four team-task tools, in registration (family) order. Return type is
 * inferred (a tuple of per-schema ToolDefinitions) — the erased
 * `ToolDefinition<TSchema, unknown>` supertype rejects the narrower
 * renderCall parameter types under strict tsc, and registerTool consumes the
 * concrete types directly.
 */
export function createTaskTools(options: TaskToolsOptions = {}) {
  const store = options.store ?? getTeamTaskStore();
  const getSessionId = options.getSessionId ?? (() => TASK_BOARD_SESSION_ID);

  const taskCreate: ToolDefinition<typeof taskCreateSchema, undefined> = defineTool({
    name: "task_create",
    label: "TaskCreate",
    description: [
      "Add a task to this session's SHARED team task board.",
      "The board is visible to you, every live agent, and every workflow agent in this session — coordinate work through it instead of private notes.",
      "Dependencies (blockedBy/blocks) are validated; cycles are rejected.",
    ].join(" "),
    promptSnippet:
      "Coordinate multi-agent work on the shared board: task_create({ subject, blockedBy }) → task ids; agents claim with task_update({ id, owner: '<name>', status: 'in_progress' }).",
    // Owner-declared gating — the workflow family (GATE_DEFS["workflow"]): the
    // board exists for the exact sessions that can spawn/corordinate agents
    // (same reference form as spawn_subagent / send_message).
    gating: { gate: "workflow" },
    parameters: taskCreateSchema,
    async execute(_toolCallId, params) {
      const created = store.create(getSessionId(), {
        subject: params.subject,
        description: params.description,
        activeForm: params.activeForm,
        owner: params.owner,
        metadata: params.metadata,
        blockedBy: params.blockedBy,
        blocks: params.blocks,
      });
      if (isTeamTaskError(created)) {
        return textResult(errorText(created, `Board: ${boardSummary(store.list(getSessionId()))}`));
      }
      return textResult(
        `Created task #${created.id} "${created.subject}". ${boardSummary(store.list(getSessionId()))}`,
      );
    },
  });

  const taskGet: ToolDefinition<typeof taskGetSchema, undefined> = defineTool({
    name: "task_get",
    label: "TaskGet",
    description: "Fetch one task from the shared team task board by id, with its full dependency edges and metadata.",
    gating: { gate: "workflow" },
    parameters: taskGetSchema,
    async execute(_toolCallId, params) {
      const task = store.get(getSessionId(), params.id);
      if (!task) {
        return textResult(`No task #${params.id} on this session's board. ${boardSummary(store.list(getSessionId()))}`);
      }
      return textResult(JSON.stringify(task, null, 2));
    },
  });

  const taskList: ToolDefinition<typeof taskListSchema, undefined> = defineTool({
    name: "task_list",
    label: "TaskList",
    description: "List the shared team task board (optionally filtered by status/owner) in creation order.",
    gating: { gate: "workflow" },
    parameters: taskListSchema,
    async execute(_toolCallId, params) {
      const all = store.list(getSessionId());
      const filtered = all.filter(
        (t) => (params.status ? t.status === params.status : true) && (params.owner ? t.owner === params.owner : true),
      );
      if (!filtered.length) {
        return textResult(
          `No tasks${params.status || params.owner ? " matching the filter" : ""} on this session's board. ` +
            "Create one with task_create.",
        );
      }
      return textResult(
        [
          `${boardSummary(filtered)}${all.length !== filtered.length ? ` (of ${all.length} total)` : ""}:`,
          ...filtered.map(taskLine),
        ].join("\n"),
      );
    },
  });

  const taskUpdate: ToolDefinition<typeof taskUpdateSchema, undefined> = defineTool({
    name: "task_update",
    label: "TaskUpdate",
    description: [
      "Update a task on the shared team task board: claim it (owner), move its status, edit fields, or link/unlink dependencies.",
      "Dependency edits are cycle-checked and rejected atomically; clearing optionals uses null.",
    ].join(" "),
    gating: { gate: "workflow" },
    parameters: taskUpdateSchema,
    async execute(_toolCallId, params) {
      const updated = store.update(getSessionId(), params.id, {
        subject: params.subject,
        description: params.description,
        activeForm: params.activeForm,
        status: params.status,
        owner: params.owner,
        metadata: params.metadata,
        addBlockedBy: params.addBlockedBy,
        removeBlockedBy: params.removeBlockedBy,
        addBlocks: params.addBlocks,
        removeBlocks: params.removeBlocks,
      });
      if (isTeamTaskError(updated)) {
        return textResult(errorText(updated, `Run task_list to see the board's current ids and edges.`));
      }
      return textResult(`Updated ${taskLine(updated)}.`);
    },
  });

  return [taskCreate, taskGet, taskList, taskUpdate];
}
