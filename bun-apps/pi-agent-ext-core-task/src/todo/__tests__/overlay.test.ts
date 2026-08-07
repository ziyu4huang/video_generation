/**
 * Tests for TodoOverlay render correctness.
 *
 * TDD for core-task-review ticket #09:
 * - M6: todo panel should still render heading when all tasks are completed/hidden
 */

import { test, expect } from "bun:test";
import { TodoOverlay } from "../overlay.js";
import { replaceState, __resetState } from "../state/store.js";
import type { Task } from "../tool/types.js";

// Minimal theme mock (only fg is used by overlay)
const T = { fg: (_c: string, s: string) => s, bold: (s: string) => s, strikethrough: (s: string) => s } as any;

test("M6: todo panel still renders heading when all tasks completed/hidden", () => {
	// Reset state before test
	__resetState();

	// Create overlay
	const overlay = new TodoOverlay();

	// Set up state with completed tasks
	const tasks: Task[] = [
		{ id: 1, subject: "task 1", status: "completed" },
		{ id: 2, subject: "task 2", status: "completed" },
		{ id: 3, subject: "task 3", status: "completed" },
	];
	replaceState({ tasks, nextId: 4 });

	// First render: this populates completedTaskIdsPendingHide with the completed tasks
	overlay.render(T, 80);

	// Now mark all completed tasks as hidden (simulating after agent_start)
	overlay.hideCompletedTasksFromPreviousTurn();

	// Second render: this should now hide the completed tasks, making overlayTasks empty
	// BUT the panel should still show the heading with counts
	const lines = overlay.render(T, 80);

	// CRITICAL: The panel should NOT vanish - it should still show the heading
	// with counts (3/3 completed) even though all tasks are hidden from the list
	expect(lines.length).toBeGreaterThan(0);

	// The heading should contain the counts
	const joined = lines.join("\n");
	expect(joined).toContain("Todos");
	expect(joined).toContain("3/3"); // 3 completed out of 3 total

	// Cleanup
	overlay.dispose();
	__resetState();
});
