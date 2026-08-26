/**
 * board-view — the TUI face's read adapter over the shared board
 * (cc-parity-task-powertool ticket 02/D7).
 *
 * Pins the ADAPTER contract: string→numeric id mapping, effective-blocked
 * filtering (completed deps render cleared — same selector the ext-subagent
 * task tools use), and the reset-detection nextId derivation. Board RULES are
 * pinned in core-runtime's team-task-store.test.ts.
 */
import { test } from "bun:test";
import assert from "node:assert/strict";
import {
	__resetTeamTaskStoreForTests,
	getTeamTaskStore,
	TeamTaskStore,
} from "@repo/s2-agent-core-runtime";
import { getBoardViewState } from "../board-view.js";

function seed() {
	// A FRESH store instance would be cleaner, but board-view addresses the
	// process singleton by design (same instance the task tools mutate) —
	// reset it instead, exactly what a session_start does.
	__resetTeamTaskStoreForTests();
	const store = getTeamTaskStore();
	store.create("*", { subject: "dep" });
	store.create("*", { subject: "dependent", blockedBy: ["1"], activeForm: "Waiting", owner: "main" });
	return store;
}

test("maps board tasks to the view shape (numeric ids, optionals only when set)", () => {
	const store = seed();
	const view = getBoardViewState();
	assert.equal(view.tasks.length, 2);
	assert.equal(view.tasks[0]?.id, 1);
	assert.equal(view.tasks[1]?.id, 2);
	assert.equal(view.tasks[1]?.subject, "dependent");
	assert.equal(view.tasks[1]?.activeForm, "Waiting");
	assert.equal(view.tasks[1]?.owner, "main");
	assert.deepEqual(view.tasks[1]?.blockedBy, [1]);
	assert.ok(!("description" in (view.tasks[0] ?? {})), "unset description stays absent");
	assert.equal(view.nextId, 3);
	// The store the tools mutate is the one the view reads (shared-module identity).
	assert.equal(store.list("*").length, 2);
});

test("effective blockedBy: a completed dep renders cleared in the TUI face", () => {
	const store = seed();
	store.update("*", "1", { status: "completed" });
	const view = getBoardViewState();
	const dependent = view.tasks.find((t) => t.subject === "dependent");
	assert.ok(dependent, "dependent still on the board");
	assert.equal(dependent.blockedBy, undefined, "completed dep must not render ⛓ in the widget");
});

test("board reset (session_start) collapses the view to an empty snapshot", () => {
	seed();
	getTeamTaskStore().reset("*");
	const view = getBoardViewState();
	assert.deepEqual(view.tasks, []);
	assert.equal(view.nextId, 1);
});

test("isolated store instances drive the adapter only through the singleton — document the seam", () => {
	// board-view reads getTeamTaskStore() by design; a bare TeamTaskStore
	// instance never reaches the view. This pin exists so a future refactor to
	// dependency injection updates THIS test, not discovers the coupling in
	// production.
	const bare = new TeamTaskStore();
	bare.create("*", { subject: "invisible" });
	__resetTeamTaskStoreForTests();
	assert.equal(getBoardViewState().tasks.length, 0);
});
