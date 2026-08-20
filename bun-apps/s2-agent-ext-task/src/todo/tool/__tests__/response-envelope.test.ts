/**
 * Tests for renderTodoResult correctness.
 *
 * TDD for core-task-review ticket #09:
 * - M4: renderTodoResult should show a failure glyph for failed ops (not ✓)
 */

import { test, expect } from "bun:test";
import { renderTodoResult } from "../../view/format.js";
import type { TaskDetails } from "../types.js";

// Minimal theme mock
const T = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as any;

test("M4: renderTodoResult shows a failure glyph for failed ops (not ✓)", () => {
	// Construct a result with details.error set (failed operation)
	const failedResult = {
		details: {
			action: "create",
			params: { subject: "test task" },
			tasks: [], // Empty tasks (failed create)
			nextId: 1,
			error: "subject required for create", // Error is set
		} satisfies TaskDetails,
	};

	// Render the failed result
	const output = renderTodoResult(failedResult, T);

	// CRITICAL: The output should NOT contain the success glyph ✓
	// It should contain a failure indicator (✗ or "Error")
	const text = (output as any).text;
	expect(text).not.toContain("✓");
	// Must contain either ✗ or Error (or both)
	const hasX = text.includes("✗");
	const hasError = text.includes("Error");
	expect(hasX || hasError).toBe(true);
});

test("renderTodoResult shows status glyph for successful create", () => {
	// Construct a successful create result
	const successResult = {
		details: {
			action: "create",
			params: { subject: "test task" },
			tasks: [{ id: 1, subject: "test task", status: "pending" }],
			nextId: 2,
		} satisfies TaskDetails,
	};

	// Render the successful result
	const output = renderTodoResult(successResult, T);

	// Should show the status glyph (○ for pending)
	const text = (output as any).text;
	expect(text).toContain("○");
	expect(text).toContain("pending");
	// Should NOT contain error indicator
	expect(text).not.toContain("✗");
	expect(text).not.toContain("Error");
});
