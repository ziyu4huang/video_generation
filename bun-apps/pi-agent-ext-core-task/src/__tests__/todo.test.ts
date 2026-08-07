/**
 * Tests for the embedded todo tool's core logic: state-reducer, task-graph, and invariants.
 *
 * Ported from @juicesharp/rpiv-todo upstream tests (rpiv-mono/packages/rpiv-todo/).
 * Stripped of rpiv-test-utils / rpiv-i18n / vitest dependencies — pure bun:test.
 *
 * Coverage:
 *   - applyTaskMutation: create, update, delete, clear, get, list (every action path)
 *   - isTransitionValid: all status transitions
 *   - detectCycle: dependency graph cycle detection
 *   - deriveBlocks: inverse adjacency map
 *   - Registration schema matches expected shape
 */
import { test, expect, describe } from "bun:test";
import type { Task, TaskAction, TaskMutationParams } from "../todo/tool/types";
import { isTransitionValid, validateReferentialIntegrity } from "../todo/state/invariants";
import type { TaskState } from "../todo/state/state";
import { applyTaskMutation, type Op, type ApplyResult } from "../todo/state/state-reducer";
import { detectCycle, deriveBlocks } from "../todo/state/task-graph";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const emptyState = (): TaskState => ({ tasks: [], nextId: 1 });

const stateWith = (...tasks: Task[]): TaskState => ({
  tasks: [...tasks],
  nextId: Math.max(0, ...tasks.map((t) => t.id)) + 1,
});

const task = (overrides: Partial<Task> & { id: number; subject: string }): Task => ({
  status: "pending",
  ...overrides,
});

// ─── applyTaskMutation — create ──────────────────────────────────────────────

describe("applyTaskMutation — create", () => {
  test("rejects empty subject", () => {
    const result = applyTaskMutation(emptyState(), "create", { subject: "" });
    expect(result.op).toEqual({ kind: "error", message: "subject required for create" });
    expect(result.state.tasks).toHaveLength(0);
    expect(result.state.nextId).toBe(1);
  });

  test("rejects whitespace-only subject", () => {
    const result = applyTaskMutation(emptyState(), "create", { subject: "   " });
    expect(result.op).toEqual({ kind: "error", message: "subject required for create" });
    expect(result.state.tasks).toHaveLength(0);
  });

  test("rejects dangling blockedBy", () => {
    const result = applyTaskMutation(emptyState(), "create", { subject: "x", blockedBy: [99] });
    expect(result.op).toEqual({ kind: "error", message: "blockedBy: #99 not found" });
    expect(result.state.nextId).toBe(1);
  });

  test("rejects deleted blockedBy", () => {
    const state = stateWith(task({ id: 1, subject: "done", status: "deleted" }));
    const result = applyTaskMutation(state, "create", { subject: "new", blockedBy: [1] });
    expect(result.op).toEqual({ kind: "error", message: "blockedBy: #1 is deleted" });
  });

  test("creates with next id and preserves immutability", () => {
    const state = emptyState();
    const result = applyTaskMutation(state, "create", { subject: "write tests" });
    expect(result.state.tasks).toHaveLength(1);
    expect(result.state.tasks[0]).toMatchObject({ id: 1, subject: "write tests", status: "pending" });
    expect(result.state.nextId).toBe(2);
    expect(result.state.tasks).not.toBe(state.tasks);
    expect(result.op).toEqual({ kind: "create", taskId: 1 });
  });

  test("creates with optional fields", () => {
    const result = applyTaskMutation(emptyState(), "create", {
      subject: "task",
      description: "desc",
      activeForm: "doing",
      owner: "me",
      metadata: { key: "val" },
      blockedBy: [],
    });
    expect(result.op).toEqual({ kind: "create", taskId: 1 });
    expect(result.state.tasks[0]).toMatchObject({
      id: 1,
      subject: "task",
      description: "desc",
      activeForm: "doing",
      owner: "me",
      metadata: { key: "val" },
    });
    expect(result.state.tasks[0].blockedBy).toBeUndefined();
  });
});

// ─── applyTaskMutation — update ──────────────────────────────────────────────

describe("applyTaskMutation — update", () => {
  test("rejects id-only update", () => {
    const state = stateWith(task({ id: 1, subject: "x" }));
    const result = applyTaskMutation(state, "update", { id: 1 });
    expect(result.op).toEqual({ kind: "error", message: "update requires at least one mutable field" });
  });

  test("rejects illegal transition completed → in_progress", () => {
    const state = stateWith(task({ id: 1, subject: "x", status: "completed" }));
    const result = applyTaskMutation(state, "update", { id: 1, status: "in_progress" });
    expect(result.op).toEqual({
      kind: "error",
      message: "illegal transition completed → in_progress",
    });
  });

  test("allows completed → deleted transition", () => {
    const state = stateWith(task({ id: 1, subject: "x", status: "completed" }));
    const result = applyTaskMutation(state, "update", { id: 1, status: "deleted" });
    expect(result.op).toEqual({ kind: "update", id: 1, fromStatus: "completed", toStatus: "deleted" });
    expect(result.state.tasks[0].status).toBe("deleted");
  });

  test("flags a no-effect status update as changed:false (no changed field in Op shape)", () => {
    // The Op shape doesn't expose a `changed` bool, but a no-op update still
    // returns the update action with matching fromStatus/toStatus.
    const state = stateWith(task({ id: 1, subject: "x", status: "pending" }));
    const result = applyTaskMutation(state, "update", { id: 1, status: "pending" });
    expect(result.op).toEqual({ kind: "update", id: 1, fromStatus: "pending", toStatus: "pending" });
  });

  test("rejects self-block via addBlockedBy", () => {
    const state = stateWith(task({ id: 1, subject: "x" }));
    const result = applyTaskMutation(state, "update", { id: 1, addBlockedBy: [1] });
    expect(result.op).toEqual({ kind: "error", message: "cannot block #1 on itself" });
  });

  test("rejects cycle in blockedBy graph", () => {
    const state = stateWith(
      task({ id: 1, subject: "a", blockedBy: [2] }),
      task({ id: 2, subject: "b" }),
    );
    const result = applyTaskMutation(state, "update", { id: 2, addBlockedBy: [1] });
    expect(result.op).toEqual({
      kind: "error",
      message: "addBlockedBy would create a cycle in the blockedBy graph",
    });
  });

  test("drops blockedBy field when merged set becomes empty", () => {
    const state = stateWith(
      task({ id: 1, subject: "a", blockedBy: [2] }),
      task({ id: 2, subject: "b" }),
    );
    const result = applyTaskMutation(state, "update", { id: 1, removeBlockedBy: [2] });
    const updated = result.state.tasks[0];
    expect("blockedBy" in updated).toBe(false);
  });

  test("drops metadata key when value is null", () => {
    const state = stateWith(task({ id: 1, subject: "x", metadata: { a: 1, b: 2 } }));
    const result = applyTaskMutation(state, "update", { id: 1, metadata: { a: null } });
    expect(result.state.tasks[0].metadata).toEqual({ b: 2 });
  });

  test("sets and overwrites metadata keys when value is non-null", () => {
    const state = stateWith(task({ id: 1, subject: "x", metadata: { a: 1, b: 2 } }));
    const result = applyTaskMutation(state, "update", { id: 1, metadata: { a: 99, c: 3 } });
    expect(result.state.tasks[0].metadata).toEqual({ a: 99, b: 2, c: 3 });
  });

  test("collapses metadata to undefined when every key is deleted", () => {
    const state = stateWith(task({ id: 1, subject: "x", metadata: { a: 1 } }));
    const result = applyTaskMutation(state, "update", { id: 1, metadata: { a: null } });
    expect("metadata" in result.state.tasks[0]).toBe(false);
  });
});

// ─── applyTaskMutation — list/get/delete/clear ────────────────────────────────

describe("applyTaskMutation — list/get/delete/clear", () => {
  test("list emits Op with includeDeleted flag and optional statusFilter", () => {
    const state = stateWith(
      task({ id: 1, subject: "a", status: "pending" }),
      task({ id: 2, subject: "b", status: "deleted" }),
    );
    const result = applyTaskMutation(state, "list", { includeDeleted: true, status: "deleted" });
    expect(result.op).toEqual({ kind: "list", includeDeleted: true, statusFilter: "deleted" });
    expect(result.state).toBe(state);
  });

  test("delete on already-deleted task errors", () => {
    const state = stateWith(task({ id: 1, subject: "x", status: "deleted" }));
    const result = applyTaskMutation(state, "delete", { id: 1 });
    expect(result.op).toEqual({ kind: "error", message: "#1 is already deleted" });
  });

  test("delete emits Op with id + subject", () => {
    const state = stateWith(task({ id: 1, subject: "x" }));
    const result = applyTaskMutation(state, "delete", { id: 1 });
    expect(result.op).toEqual({ kind: "delete", id: 1, subject: "x" });
    expect(result.state.tasks[0].status).toBe("deleted");
  });

  test("clear emits Op with prior count and resets nextId to 1", () => {
    const state = stateWith(task({ id: 5, subject: "x" }));
    const result = applyTaskMutation(state, "clear", {});
    expect(result.op).toEqual({ kind: "clear", count: 1 });
    expect(result.state.tasks).toHaveLength(0);
    expect(result.state.nextId).toBe(1);
  });

  test("get emits Op with the resolved task", () => {
    const state = stateWith(task({ id: 1, subject: "alpha" }));
    const result = applyTaskMutation(state, "get", { id: 1 });
    expect(result.op).toEqual({ kind: "get", task: state.tasks[0] });
  });

  test("get on missing id errors", () => {
    const result = applyTaskMutation(emptyState(), "get", { id: 99 });
    expect(result.op).toEqual({ kind: "error", message: "#99 not found" });
  });

  test("delete on missing id errors", () => {
    const result = applyTaskMutation(emptyState(), "delete", { id: 99 });
    expect(result.op).toEqual({ kind: "error", message: "#99 not found" });
  });

  // ─── core-task-review #10: todo delete referential integrity ─────────────────

  test("#10: delete prunes blockedBy from dependent tasks", () => {
    // Create tasks: A blockedBy B, B blockedBy C
    let state = emptyState();
    state = applyTaskMutation(state, "create", { subject: "C" }).state;
    state = applyTaskMutation(state, "create", { subject: "B", blockedBy: [1] }).state;
    state = applyTaskMutation(state, "create", { subject: "A", blockedBy: [2] }).state;

    // Before delete: A has blockedBy [2], B has blockedBy [1]
    expect(state.tasks[2].blockedBy).toEqual([2]);
    expect(state.tasks[1].blockedBy).toEqual([1]);

    // Delete task B (id=2)
    const result = applyTaskMutation(state, "delete", { id: 2 });

    // B should be marked deleted
    expect(result.state.tasks[1].status).toBe("deleted");

    // A's blockedBy should no longer contain B (id=2)
    const taskA = result.state.tasks.find((t) => t.id === 3);
    expect(taskA?.blockedBy).toBeUndefined(); // dropped when empty

    // Op should report dependent A (id=3) as affected
    expect(result.op.kind).toBe("delete");
    if (result.op.kind === "delete") {
      expect(result.op.dependentsAffected).toEqual([3]);
    }
  });

  test("#10: delete with multiple dependents prunes all blockedBy entries", () => {
    // Create tasks: root, and three tasks depending on it
    let state = emptyState();
    state = applyTaskMutation(state, "create", { subject: "root" }).state;
    state = applyTaskMutation(state, "create", { subject: "dep1", blockedBy: [1] }).state;
    state = applyTaskMutation(state, "create", { subject: "dep2", blockedBy: [1] }).state;
    state = applyTaskMutation(state, "create", { subject: "dep3", blockedBy: [1] }).state;

    // All deps should have blockedBy [1]
    expect(state.tasks[1].blockedBy).toEqual([1]);
    expect(state.tasks[2].blockedBy).toEqual([1]);
    expect(state.tasks[3].blockedBy).toEqual([1]);

    // Delete root
    const result = applyTaskMutation(state, "delete", { id: 1 });

    // All deps should have blockedBy removed
    expect(result.state.tasks[1].blockedBy).toBeUndefined();
    expect(result.state.tasks[2].blockedBy).toBeUndefined();
    expect(result.state.tasks[3].blockedBy).toBeUndefined();

    // Op should report all three dependents
    expect(result.op.kind).toBe("delete");
    if (result.op.kind === "delete") {
      expect(result.op.dependentsAffected?.sort()).toEqual([2, 3, 4]);
    }
  });

  test("#10: delete with no dependents yields no dependentsAffected", () => {
    // Create a task with no dependents
    let state = emptyState();
    state = applyTaskMutation(state, "create", { subject: "lone task" }).state;

    // Delete it
    const result = applyTaskMutation(state, "delete", { id: 1 });

    // Op should have no dependentsAffected (undefined, not empty array)
    expect(result.op.kind).toBe("delete");
    if (result.op.kind === "delete") {
      expect(result.op.dependentsAffected).toBeUndefined();
    }
  });

  test("#10: delete prunes only the deleted id from multi-dependency blockedBy", () => {
    // Create tasks: A, B, C, D; D blockedBy [A, B, C]
    let state = emptyState();
    state = applyTaskMutation(state, "create", { subject: "A" }).state;
    state = applyTaskMutation(state, "create", { subject: "B" }).state;
    state = applyTaskMutation(state, "create", { subject: "C" }).state;
    state = applyTaskMutation(state, "create", { subject: "D", blockedBy: [1, 2, 3] }).state;

    // Delete only B (id=2)
    const result = applyTaskMutation(state, "delete", { id: 2 });

    // D's blockedBy should now be [1, 3] (B removed)
    const taskD = result.state.tasks.find((t) => t.id === 4);
    expect(taskD?.blockedBy?.sort()).toEqual([1, 3]);

    // Op should report D as the only affected dependent
    expect(result.op.kind).toBe("delete");
    if (result.op.kind === "delete") {
      expect(result.op.dependentsAffected).toEqual([4]);
    }
  });
});

// ─── validateReferentialIntegrity ──────────────────────────────────────────────

describe("validateReferentialIntegrity", () => {
  test("returns unchanged tasks when deleted id not in any blockedBy", () => {
    const tasks: Task[] = [
      { id: 1, subject: "a", status: "pending" },
      { id: 2, subject: "b", status: "pending" },
    ];
    const result = validateReferentialIntegrity(tasks, 99);
    expect(result.updatedTasks).toEqual(tasks);
    expect(result.dependentsAffected).toEqual([]);
  });

  test("removes deleted id from single dependent's blockedBy", () => {
    const tasks: Task[] = [
      { id: 1, subject: "a", status: "pending" },
      { id: 2, subject: "b", status: "pending", blockedBy: [1] },
    ];
    const result = validateReferentialIntegrity(tasks, 1);
    expect(result.updatedTasks[1].blockedBy).toBeUndefined();
    expect(result.dependentsAffected).toEqual([2]);
  });

  test("removes deleted id from multiple dependents' blockedBy", () => {
    const tasks: Task[] = [
      { id: 1, subject: "root", status: "pending" },
      { id: 2, subject: "dep1", status: "pending", blockedBy: [1] },
      { id: 3, subject: "dep2", status: "pending", blockedBy: [1] },
    ];
    const result = validateReferentialIntegrity(tasks, 1);
    expect(result.updatedTasks[1].blockedBy).toBeUndefined();
    expect(result.updatedTasks[2].blockedBy).toBeUndefined();
    expect(result.dependentsAffected.sort()).toEqual([2, 3]);
  });

  test("drops blockedBy field when it becomes empty after prune", () => {
    const tasks: Task[] = [
      { id: 1, subject: "a", status: "pending" },
      { id: 2, subject: "b", status: "pending", blockedBy: [1] },
    ];
    const result = validateReferentialIntegrity(tasks, 1);
    expect("blockedBy" in result.updatedTasks[1]).toBe(false);
  });

  test("keeps non-empty blockedBy after partial prune", () => {
    const tasks: Task[] = [
      { id: 1, subject: "a", status: "pending" },
      { id: 2, subject: "b", status: "pending" },
      { id: 3, subject: "c", status: "pending", blockedBy: [1, 2] },
    ];
    const result = validateReferentialIntegrity(tasks, 1);
    expect(result.updatedTasks[2].blockedBy).toEqual([2]);
  });

  test("does not modify the deleted task itself", () => {
    const tasks: Task[] = [
      { id: 1, subject: "a", status: "pending" },
      { id: 2, subject: "b", status: "pending", blockedBy: [1] },
    ];
    const result = validateReferentialIntegrity(tasks, 2);
    // Task 2 (the deleted one) should be unchanged
    expect(result.updatedTasks[1]).toEqual(tasks[1]);
    // Task 1 should be unchanged (it doesn't depend on 2)
    expect(result.updatedTasks[0]).toEqual(tasks[0]);
    expect(result.dependentsAffected).toEqual([]);
  });
});

// ─── isTransitionValid ───────────────────────────────────────────────────────

describe("isTransitionValid", () => {
  test("is idempotent on same→same", () => {
    expect(isTransitionValid("completed", "completed")).toBe(true);
  });

  test("rejects completed → in_progress", () => {
    expect(isTransitionValid("completed", "in_progress")).toBe(false);
  });

  test("allows completed → deleted", () => {
    expect(isTransitionValid("completed", "deleted")).toBe(true);
  });

  test("allows pending → in_progress", () => {
    expect(isTransitionValid("pending", "in_progress")).toBe(true);
  });

  test("allows in_progress → completed", () => {
    expect(isTransitionValid("in_progress", "completed")).toBe(true);
  });

  test("rejects deleted → in_progress", () => {
    expect(isTransitionValid("deleted", "in_progress")).toBe(false);
  });

  test("rejects deleted → completed", () => {
    expect(isTransitionValid("deleted", "completed")).toBe(false);
  });

  test("allows pending → completed (embedded inlining allows direct skip to completed)", () => {
    expect(isTransitionValid("pending", "completed")).toBe(true);
  });
});

// ─── detectCycle ─────────────────────────────────────────────────────────────

describe("detectCycle", () => {
  test("detects direct cycle", () => {
    const tasks = [task({ id: 1, subject: "a" }), task({ id: 2, subject: "b", blockedBy: [1] })];
    expect(detectCycle(tasks, 1, [2])).toBe(true);
  });

  test("returns false for acyclic graph", () => {
    const tasks = [task({ id: 1, subject: "a" }), task({ id: 2, subject: "b", blockedBy: [1] })];
    expect(detectCycle(tasks, 2, [1])).toBe(false);
  });

  test("detects indirect cycle (A→B→C→A)", () => {
    const tasks = [
      task({ id: 1, subject: "a", blockedBy: [2] }),
      task({ id: 2, subject: "b", blockedBy: [3] }),
      task({ id: 3, subject: "c" }),
    ];
    expect(detectCycle(tasks, 3, [1])).toBe(true);
  });

  test("empty blockedBy never creates a cycle", () => {
    const tasks = [task({ id: 1, subject: "a" }), task({ id: 2, subject: "b" })];
    expect(detectCycle(tasks, 1, [])).toBe(false);
  });
});

// ─── deriveBlocks ────────────────────────────────────────────────────────────

describe("deriveBlocks", () => {
  test("returns an empty map when no task has blockedBy", () => {
    const tasks: Task[] = [
      { id: 1, subject: "a", status: "pending" },
      { id: 2, subject: "b", status: "pending" },
    ];
    expect(deriveBlocks(tasks).size).toBe(0);
  });

  test("inverts blockedBy into a blocks map", () => {
    const tasks: Task[] = [
      { id: 1, subject: "root", status: "pending" },
      { id: 2, subject: "dep", status: "pending", blockedBy: [1] },
      { id: 3, subject: "dep2", status: "pending", blockedBy: [1, 2] },
    ];
    const blocks = deriveBlocks(tasks);
    expect(blocks.get(1)).toEqual([2, 3]);
    expect(blocks.get(2)).toEqual([3]);
    expect(blocks.get(3)).toBeUndefined();
  });
});

// ─── Registration schema ─────────────────────────────────────────────────────

describe("todo registration schema", () => {
  test("TOOL_NAME and COMMAND_NAME are defined", () => {
    const { TOOL_NAME, COMMAND_NAME } = require("../todo/tool/types");
    expect(typeof TOOL_NAME).toBe("string");
    expect(TOOL_NAME.length).toBeGreaterThan(0);
    expect(typeof COMMAND_NAME).toBe("string");
    expect(COMMAND_NAME.length).toBeGreaterThan(0);
  });

  test("TodoParamsSchema defines all expected fields", () => {
    const { TodoParamsSchema } = require("../todo/tool/types");
    const schema = TodoParamsSchema as any;
    expect(schema).toBeDefined();
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();

    // Check required action
    const actionProp = schema.properties.action;
    expect(actionProp).toBeDefined();
    expect(actionProp.enum).toContain("create");
    expect(actionProp.enum).toContain("update");
    expect(actionProp.enum).toContain("list");
    expect(actionProp.enum).toContain("get");
    expect(actionProp.enum).toContain("delete");
    expect(actionProp.enum).toContain("clear");

    // Check optional fields
    expect(schema.properties.subject).toBeDefined();
    expect(schema.properties.status).toBeDefined();
    expect(schema.properties.id).toBeDefined();
    expect(schema.properties.blockedBy).toBeDefined();
    expect(schema.properties.addBlockedBy).toBeDefined();
    expect(schema.properties.removeBlockedBy).toBeDefined();
    expect(schema.properties.description).toBeDefined();
    expect(schema.properties.activeForm).toBeDefined();
    expect(schema.properties.owner).toBeDefined();
    expect(schema.properties.metadata).toBeDefined();
    expect(schema.properties.includeDeleted).toBeDefined();
  });
});
