/**
 * Ported from @juicesharp/rpiv-todo state/replay.test.ts — upstream tests for
 * `replayFromBranch` and `isTaskDetails` defensive type guard.
 *
 * Stripped of rpiv-test-utils / vitest — uses bun:test with inline mock helpers.
 * See the goal doc: `output/next-goal-20260705_090000.md#priority-3`
 */
import { test, expect, describe } from "bun:test";
import type { Task, TaskDetails } from "../todo/tool/types";
import { isTaskDetails, replayFromBranch } from "../todo/state/replay";

// ─── Inline mock helpers (formerly @juicesharp/rpiv-test-utils) ────────────

type BranchEntry = { type: "message"; message: { role: string; toolName?: string; details?: unknown } };

/** Build a session branch (array of BranchEntry) from a list of message bodies. */
function buildSessionEntries(
	messages: { role: string; toolName?: string; details?: unknown }[],
): BranchEntry[] {
	return messages.map((msg) => ({ type: "message", message: msg }));
}

/** Create a mock ctx whose `.sessionManager.getBranch()` returns the given entries. */
function createMockCtx(over: { branch: BranchEntry[] }): {
	sessionManager: { getBranch(): Iterable<unknown> };
} {
	return {
		sessionManager: { getBranch: () => over.branch },
	};
}

/** Create a todo toolResult message body. */
function makeTodoToolResult(details: TaskDetails): {
	role: "toolResult";
	toolName: "todo";
	details: TaskDetails;
} {
	return { role: "toolResult", toolName: "todo", details };
}

/** Create a user message body. */
function makeUserMessage(_text: string): { role: "user" } {
	return { role: "user" };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

function buildBranch(snapshots: TaskDetails[]): BranchEntry[] {
	const messages = snapshots.map((s) => makeTodoToolResult(s));
	return buildSessionEntries([makeUserMessage("hi"), ...messages]);
}

const taskFixture = (id: number, subject: string, extra: Partial<Task> = {}): Task => ({
	id,
	subject,
	status: "pending",
	...extra,
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe("isTaskDetails — defensive type guard", () => {
	test("rejects null and undefined", () => {
		expect(isTaskDetails(null)).toBe(false);
		expect(isTaskDetails(undefined)).toBe(false);
	});

	test("rejects primitives (string, number, boolean)", () => {
		expect(isTaskDetails("oops")).toBe(false);
		expect(isTaskDetails(42)).toBe(false);
		expect(isTaskDetails(true)).toBe(false);
	});

	test("rejects objects missing tasks[] or nextId", () => {
		expect(isTaskDetails({})).toBe(false);
		expect(isTaskDetails({ tasks: "x", nextId: 1 })).toBe(false);
		expect(isTaskDetails({ tasks: [], nextId: "1" })).toBe(false);
	});

	test("accepts well-formed snapshot envelopes", () => {
		expect(isTaskDetails({ tasks: [], nextId: 1 })).toBe(true);
		expect(isTaskDetails({ action: "create", params: {}, tasks: [], nextId: 1 })).toBe(true);
	});
});

describe("replayFromBranch", () => {
	test("returns empty TaskState when branch has no todo toolResults", () => {
		const ctx = createMockCtx({ branch: buildSessionEntries([makeUserMessage("hi")]) });
		const state = replayFromBranch(ctx);
		expect(state.tasks).toEqual([]);
		expect(state.nextId).toBe(1);
	});

	test("replays the last snapshot (last-write-wins)", () => {
		const ctx = createMockCtx({
			branch: buildBranch([
				{ action: "create", params: {}, tasks: [taskFixture(1, "old")], nextId: 2 },
				{
					action: "create",
					params: {},
					tasks: [taskFixture(1, "old"), taskFixture(2, "new")],
					nextId: 3,
				},
			]),
		});
		const state = replayFromBranch(ctx);
		expect(state.tasks).toHaveLength(2);
		expect(state.nextId).toBe(3);
	});

	test("clones tasks so mutating the fixture does not mutate replayed state", () => {
		const fixture: Task = taskFixture(1, "original");
		const ctx = createMockCtx({
			branch: buildBranch([{ action: "create", params: {}, tasks: [fixture], nextId: 2 }]),
		});
		const state = replayFromBranch(ctx);
		const replayed = state.tasks[0];
		expect(replayed).not.toBe(fixture);
		expect(replayed?.subject).toBe("original");
	});

	test("skips non-message entries in the branch (defensive type guard)", () => {
		const ctx = createMockCtx({
			branch: [
				{ type: "tool_call" as const, call: { id: "x" } },
				...buildBranch([{ action: "create", params: {}, tasks: [taskFixture(1, "kept")], nextId: 2 }]),
			] as BranchEntry[],
		});
		const state = replayFromBranch(ctx);
		expect(state.tasks).toHaveLength(1);
		expect(state.tasks[0]?.subject).toBe("kept");
		expect(state.nextId).toBe(2);
	});

	test("skips toolResult entries whose details fail isTaskDetails (corrupt-snapshot guard)", () => {
		const corrupt: BranchEntry = {
			type: "message",
			message: { role: "toolResult", toolName: "todo", details: { tasks: "not-an-array" } },
		};
		const ctx = createMockCtx({
			branch: [
				...buildBranch([{ action: "create", params: {}, tasks: [taskFixture(1, "good")], nextId: 2 }]),
				corrupt as BranchEntry,
			],
		});
		const state = replayFromBranch(ctx);
		expect(state.tasks).toHaveLength(1);
		expect(state.tasks[0]?.subject).toBe("good");
	});

	test("returns a fresh empty TaskState when called with an empty branch", () => {
		const ctx = createMockCtx({
			branch: buildBranch([{ action: "create", params: {}, tasks: [taskFixture(1, "x")], nextId: 2 }]),
		});
		expect(replayFromBranch(ctx).nextId).toBe(2);

		const ctx2 = createMockCtx({ branch: buildSessionEntries([makeUserMessage("hi")]) });
		const fresh = replayFromBranch(ctx2);
		expect(fresh.tasks).toEqual([]);
		expect(fresh.nextId).toBe(1);
	});
});
