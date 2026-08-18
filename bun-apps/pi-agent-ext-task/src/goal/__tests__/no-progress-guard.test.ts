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
});
