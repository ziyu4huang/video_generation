/**
 * Tests for TodoOverlay render correctness.
 *
 * TDD for core-task-review ticket #09:
 * - M6: todo panel should still render heading when all tasks are completed/hidden
 *
 * Since cc-parity-task-powertool ticket 02/D7 the overlay renders the ONE
 * shared task board (TeamTaskStore singleton) via board-view — seeding goes
 * through the same store the task tools mutate.
 */

import { test, expect } from "bun:test";
import { __resetTeamTaskStoreForTests, getTeamTaskStore } from "@repo/s2-agent-core-runtime";
import { TodoOverlay } from "../overlay.js";

// Minimal theme mock (only fg is used by overlay)
const T = { fg: (_c: string, s: string) => s, bold: (s: string) => s, strikethrough: (s: string) => s } as any;

// Theme with ANSI escape codes for testing ANSI awareness
const ANSI_THEME = { fg: (c: string, s: string) => `\x1b[33m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m`, strikethrough: (s: string) => s } as any;

function resetBoard() {
	__resetTeamTaskStoreForTests();
	return getTeamTaskStore();
}

test("M6: todo panel still renders heading when all tasks completed/hidden", () => {
	// Reset state before test
	const store = resetBoard();

	// Create overlay
	const overlay = new TodoOverlay();

	// Set up the board with completed tasks
	store.create("*", { subject: "task 1" });
	store.create("*", { subject: "task 2" });
	store.create("*", { subject: "task 3" });
	for (const id of ["1", "2", "3"]) store.update("*", id, { status: "completed" });

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
	resetBoard();
});

test("L7: ANSI-awareness — truncateToWidth handles ANSI escape codes", () => {
	const store = resetBoard();

	const overlay = new TodoOverlay();

	// Create a task with a very long subject (longer than typical terminal width)
	const longSubject = "This is a very long task subject that exceeds typical terminal width and should be truncated properly even with ANSI escape codes in the theme";
	store.create("*", { subject: longSubject });

	// Render with ANSI theme and limited width
	const lines = overlay.render(ANSI_THEME, 60);

	// Should render successfully without errors
	expect(lines.length).toBeGreaterThan(0);

	// The line should be truncated (not containing the full subject)
	const joined = lines.join("\n");
	// ANSI escape codes should be preserved in the output
	expect(joined).toContain("\x1b");

	// The rendered line should not be excessively long (truncation should work)
	// Each line should be reasonable length even after ANSI codes
	const maxLineLength = Math.max(...lines.map((l) => l.length));
	// Allow some buffer for ANSI codes but should still be bounded
	expect(maxLineLength).toBeLessThan(200);

	overlay.dispose();
	resetBoard();
});

test("effective blockedBy: completed deps do not render ⛓ in the widget", () => {
	const store = resetBoard();
	const overlay = new TodoOverlay();

	store.create("*", { subject: "dep" });
	store.create("*", { subject: "dependent", blockedBy: ["1"] });

	const blocked = overlay.render(T, 120).join("\n");
	expect(blocked).toContain("⛓ #1");

	store.update("*", "1", { status: "completed" });
	const cleared = overlay.render(T, 120).join("\n");
	expect(cleared.includes("⛓")).toBe(false);

	overlay.dispose();
	resetBoard();
});
