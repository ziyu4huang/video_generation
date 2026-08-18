/**
 * Unit tests for the no-progress guard (issue #1616): `turnMadeToolProgress`
 * decides whether a finished turn contained any tool activity, feeding the
 * 3-strikes auto-pause in `agent_end` before the next continuation fires.
 */
import { describe, expect, test } from "bun:test";
import { turnMadeToolProgress } from "../hooks.js";

describe("turnMadeToolProgress", () => {
	test("guard: detects tool_use content blocks as progress", () => {
		const messages = [{ role: "assistant", content: [{ type: "tool_use", id: "t1" }] }];
		expect(turnMadeToolProgress(messages)).toBe(true);
	});

	test("guard: plain text turn is no progress", () => {
		const messages = [{ role: "assistant", content: [{ type: "text", text: "hi" }] }];
		expect(turnMadeToolProgress(messages)).toBe(false);
	});

	test("guard: empty messages is no progress", () => {
		expect(turnMadeToolProgress([])).toBe(false);
	});

	test("guard: toolCall key variants count as progress", () => {
		const messages = [{ role: "assistant", toolCalls: [{ name: "x" }] }];
		expect(turnMadeToolProgress(messages)).toBe(true);
	});

	test("guard: stale tool_use before the turn's user message does not count as progress", () => {
		// Full-history shape: an old assistant turn used tools, then the user
		// sent the continuation prompt, then the new turn is plain narration.
		// The stale tool_use must NOT reset the no-progress counter.
		const messages = [
			{ role: "assistant", content: [{ type: "tool_use", id: "stale" }] },
			{ role: "user", content: "continue working on the goal" },
			{ role: "assistant", content: [{ type: "text", text: "all done narrating" }] },
		];
		expect(turnMadeToolProgress(messages)).toBe(false);
	});

	test("guard: tool_use after the turn's user message counts as progress", () => {
		const messages = [
			{ role: "user", content: "go" },
			{ role: "assistant", content: [{ type: "tool_use", id: "t1" }] },
		];
		expect(turnMadeToolProgress(messages)).toBe(true);
	});
});
