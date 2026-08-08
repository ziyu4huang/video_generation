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
import { test, expect, describe, beforeEach } from "bun:test";
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

  test("handles simultaneous add+remove (caller-merged set)", () => {
    // Task 1 is blocked by [2, 3]; we want to remove 2 and add 4.
    // The pre-merged set is [3, 4]; this should not create a cycle.
    const tasks = [
      task({ id: 1, subject: "a", blockedBy: [2, 3] }),
      task({ id: 2, subject: "b" }),
      task({ id: 3, subject: "c" }),
      task({ id: 4, subject: "d" }),
    ];
    expect(detectCycle(tasks, 1, [3, 4])).toBe(false);
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

  test("TodoParamsSchema is a discriminated union with action discriminator", () => {
    const { TodoParamsSchema } = require("../todo/tool/types");
    const schema = TodoParamsSchema as any;
    expect(schema).toBeDefined();
    // Schema is now a Union, not a single Object
    expect(schema.anyOf || schema.oneOf).toBeDefined();
  });
});

// ─── core-task-review #11: todo schema/reducer drift ─────────────────────────

describe("core-task-review #11: todo schema/reducer drift", () => {
  // Reducer validation tests (defense-in-depth layer)
  describe("reducer rejects blockedBy/status on wrong actions", () => {
    test("update with blockedBy returns clear error (not misleading 'requires mutable field')", () => {
      const state = stateWith(task({ id: 1, subject: "x" }));
      const result = applyTaskMutation(state, "update", { id: 1, blockedBy: [2] });
      expect(result.op).toEqual({
        kind: "error",
        message: "blockedBy is not accepted on update; use addBlockedBy/removeBlockedBy instead",
      });
    });

    test("create with status returns clear error (no silent forced-pending)", () => {
      const state = emptyState();
      const result = applyTaskMutation(state, "create", { subject: "test", status: "in_progress" });
      expect(result.op).toEqual({
        kind: "error",
        message: "status is not accepted on create; tasks start as 'pending'",
      });
    });

    test("create with addBlockedBy/removeBlockedBy returns clear error", () => {
      const state = emptyState();
      const result = applyTaskMutation(state, "create", { subject: "test", addBlockedBy: [1] });
      expect(result.op).toEqual({
        kind: "error",
        message: "addBlockedBy/removeBlockedBy are not accepted on create; use blockedBy instead",
      });
    });

    test("update with includeDeleted returns clear error", () => {
      const state = stateWith(task({ id: 1, subject: "x" }));
      const result = applyTaskMutation(state, "update", { id: 1, includeDeleted: true });
      expect(result.op).toEqual({
        kind: "error",
        message: "includeDeleted is not accepted on update; use it on list action",
      });
    });
  });

  describe("reducer rejects extraneous fields on list/get/delete/clear", () => {
    test("list with subject returns error", () => {
      const state = stateWith(task({ id: 1, subject: "x" }));
      const result = applyTaskMutation(state, "list", { subject: "test" });
      expect(result.op).toEqual({
        kind: "error",
        message: "list action does not accept: subject",
      });
    });

    test("list with multiple invalid fields returns error listing all", () => {
      const state = stateWith(task({ id: 1, subject: "x" }));
      const result = applyTaskMutation(state, "list", { subject: "test", id: 1, blockedBy: [2] });
      expect(result.op).toEqual({
        kind: "error",
        message: "list action does not accept: subject, blockedBy, id",
      });
    });

    test("get with status returns error", () => {
      const state = stateWith(task({ id: 1, subject: "x" }));
      const result = applyTaskMutation(state, "get", { id: 1, status: "completed" });
      expect(result.op).toEqual({
        kind: "error",
        message: "get action does not accept: status",
      });
    });

    test("delete with status returns error", () => {
      const state = stateWith(task({ id: 1, subject: "x" }));
      const result = applyTaskMutation(state, "delete", { id: 1, status: "deleted" });
      expect(result.op).toEqual({
        kind: "error",
        message: "delete action does not accept: status",
      });
    });

    test("clear with any field returns error", () => {
      const state = stateWith(task({ id: 1, subject: "x" }));
      const result = applyTaskMutation(state, "clear", { status: "deleted" });
      expect(result.op).toEqual({
        kind: "error",
        message: "clear action does not accept: status",
      });
    });
  });

  describe("happy path: honoring actions still work correctly", () => {
    test("create with blockedBy works correctly", () => {
      let state = emptyState();
      // First create a task to depend on
      state = applyTaskMutation(state, "create", { subject: "dependency" }).state;
      // Now create a task with blockedBy
      const result = applyTaskMutation(state, "create", { subject: "dependent", blockedBy: [1] });
      expect(result.op.kind).toBe("create");
      if (result.op.kind === "create") {
        expect(result.op.taskId).toBe(2);
      }
      expect(result.state.tasks[1].blockedBy).toEqual([1]);
      expect(result.state.tasks[1].status).toBe("pending"); // still hardcodes to pending
    });

    test("update with status works correctly", () => {
      const state = stateWith(task({ id: 1, subject: "x", status: "pending" }));
      const result = applyTaskMutation(state, "update", { id: 1, status: "in_progress" });
      expect(result.op.kind).toBe("update");
      if (result.op.kind === "update") {
        expect(result.op.fromStatus).toBe("pending");
        expect(result.op.toStatus).toBe("in_progress");
      }
      expect(result.state.tasks[0].status).toBe("in_progress");
    });

    test("update with addBlockedBy/removeBlockedBy works correctly", () => {
      let state = emptyState();
      state = applyTaskMutation(state, "create", { subject: "A" }).state;
      state = applyTaskMutation(state, "create", { subject: "B" }).state;
      state = applyTaskMutation(state, "create", { subject: "C" }).state;
      // Add B to A's blockedBy
      let result = applyTaskMutation(state, "update", { id: 1, addBlockedBy: [2] });
      expect(result.state.tasks[0].blockedBy).toEqual([2]);
      // Add C to A's blockedBy
      result = applyTaskMutation(result.state, "update", { id: 1, addBlockedBy: [3] });
      expect(result.state.tasks[0].blockedBy).toEqual([2, 3]);
      // Remove B from A's blockedBy
      result = applyTaskMutation(result.state, "update", { id: 1, removeBlockedBy: [2] });
      expect(result.state.tasks[0].blockedBy).toEqual([3]);
    });

    test("list with status filter works correctly", () => {
      const state = stateWith(
        task({ id: 1, subject: "pending", status: "pending" }),
        task({ id: 2, subject: "completed", status: "completed" }),
      );
      const result = applyTaskMutation(state, "list", { status: "completed" });
      expect(result.op.kind).toBe("list");
      if (result.op.kind === "list") {
        expect(result.op.statusFilter).toBe("completed");
      }
    });

    test("list with includeDeleted works correctly", () => {
      const state = stateWith(task({ id: 1, subject: "deleted", status: "deleted" }));
      const result = applyTaskMutation(state, "list", { includeDeleted: true });
      expect(result.op.kind).toBe("list");
      if (result.op.kind === "list") {
        expect(result.op.includeDeleted).toBe(true);
      }
    });
  });
});

// ─── Cross-session isolation (L10) ─────────────────────────────────────────────

describe("cross-session store isolation", () => {
  const { replaceState, getState, __resetState } = require("../todo/state/store");

  beforeEach(() => {
    __resetState();
  });

  test("replaceState(EMPTY_STATE) clears state and fresh create restarts at id 1", () => {
    const { applyTaskMutation } = require("../todo/state/state-reducer");
    const { EMPTY_STATE } = require("../todo/state/state");

    // Populate state with multiple tasks
    let state = getState();
    state = applyTaskMutation(state, "create", { subject: "task 1" }).state;
    state = applyTaskMutation(state, "create", { subject: "task 2" }).state;
    state = applyTaskMutation(state, "create", { subject: "task 3" }).state;

    // Verify we have 3 tasks and nextId is 4
    expect(state.tasks.length).toBe(3);
    expect(state.nextId).toBe(4);

    // Simulate session reset: replaceState with EMPTY_STATE
    replaceState(EMPTY_STATE);

    // Verify state is now empty
    const clearedState = getState();
    expect(clearedState.tasks.length).toBe(0);
    expect(clearedState.nextId).toBe(1);

    // Fresh create after replaceState should start at id 1
    const result = applyTaskMutation(clearedState, "create", { subject: "new task" });
    expect(result.state.tasks[0].id).toBe(1);
    expect(result.state.nextId).toBe(2);
  });

  test("EMPTY_STATE is frozen (cannot be mutated by reference)", () => {
    const { EMPTY_STATE } = require("../todo/state/state");

    // EMPTY_STATE should be frozen
    expect(Object.isFrozen(EMPTY_STATE)).toBe(true);
    expect(Object.isFrozen(EMPTY_STATE.tasks)).toBe(true);

    // Attempting to mutate EMPTY_STATE should throw (strict mode / frozen array)
    expect(() => {
      (EMPTY_STATE as any).tasks.push({ id: 99, subject: "hack", status: "pending" });
    }).toThrow();

    // EMPTY_STATE should remain unchanged
    expect(EMPTY_STATE.tasks.length).toBe(0);
    expect(EMPTY_STATE.nextId).toBe(1);
  });
});

// ─── Optimization #3 / ticket #16: per-sessionId store isolation ──────────────

describe("per-sessionId store isolation (ticket #16)", () => {
  const { setRenderSid, replaceState, getState, __resetState } = require("../todo/state/store");

  beforeEach(() => {
    __resetState(); // no-arg: clear ALL buckets + reset renderSid
  });

  test("#3 todo store isolated per sessionId (parent vs in-process child)", () => {
    setRenderSid("parent");
    // parent adds a task
    replaceState({ tasks: [{ id: 1, subject: "parent task", status: "pending" } as any], nextId: 2 }, "parent");
    // child (distinct sid) adds a DIFFERENT task — must NOT touch the parent bucket
    replaceState({ tasks: [{ id: 1, subject: "child task", status: "pending" } as any], nextId: 2 }, "child");

    expect(getState("parent").tasks.map((t: any) => t.subject)).toEqual(["parent task"]);
    expect(getState("child").tasks.map((t: any) => t.subject)).toEqual(["child task"]);
    // no-arg reads the renderSid (parent) bucket — display code sees the parent's todos
    expect(getState().tasks.map((t: any) => t.subject)).toEqual(["parent task"]);
    // resetting the child leaves the parent intact
    __resetState("child");
    expect(getState("parent").tasks).toHaveLength(1);
    expect(getState("child").tasks).toHaveLength(0);
  });

  test("no-arg accessors default to the renderSid bucket (display path)", () => {
    setRenderSid("display");
    // no-arg replaceState writes the renderSid bucket
    replaceState({ tasks: [{ id: 1, subject: "visible", status: "in_progress" } as any], nextId: 2 });
    // an explicit other-sid write must not leak into the display bucket
    replaceState({ tasks: [{ id: 1, subject: "hidden", status: "pending" } as any], nextId: 2 }, "other");
    expect(getState().tasks.map((t: any) => t.subject)).toEqual(["visible"]);
    expect(getState("other").tasks.map((t: any) => t.subject)).toEqual(["hidden"]);
  });
});
