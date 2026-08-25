/**
 * Tests for the model-facing response envelope of ask_user_question.
 *
 * Tier: P0 — pure logic, no TUI deps.
 *
 * Covers: buildQuestionnaireResponse content lines — user notes MUST reach the
 *         LLM-visible `content` (not only the renderer-side `details`), header
 *         prefixing, and both cancelled branches (partial answers vs none).
 */
import { test, expect, describe } from "bun:test";
import type { QuestionAnswer, QuestionData, QuestionParams, QuestionnaireResult } from "../types.js";
import { buildQuestionnaireResponse } from "../response-envelope.js";
import { formatQuestionAnswer } from "../format-answer.js";

function makeParams(): QuestionParams {
	return {
		questions: [
			{
				question: "Which library?",
				header: "Library",
				options: [
					{ label: "Bun", description: "Fast" },
					{ label: "Node", description: "Ubiquitous" },
				],
			} satisfies QuestionData,
		],
	};
}

function makeAnswer(override: Partial<QuestionAnswer> = {}): QuestionAnswer {
	return {
		questionIndex: 0,
		question: "Which library?",
		kind: "option",
		answer: "Bun",
		...override,
	};
}

describe("formatQuestionAnswer notes rendering", () => {
	test("option answer with a note appends the note", () => {
		const line = formatQuestionAnswer(makeAnswer({ notes: "prefer bun" }));
		expect(line).toBe("Which library? → Bun — note: prefer bun");
	});

	test("custom answer with a note appends the note", () => {
		const line = formatQuestionAnswer(
			makeAnswer({ kind: "custom", answer: "Deno", notes: "  edge-first  " }),
		);
		expect(line).toBe("Which library? → (custom) Deno — note: edge-first");
	});

	test("multi answer with a note appends the note after the bracket list", () => {
		const line = formatQuestionAnswer(
			makeAnswer({ kind: "multi", selected: ["Bun", "Node"], answer: null, notes: "both fine" }),
		);
		expect(line).toBe("Which library? → [Bun, Node] — note: both fine");
	});

	test("whitespace-only note is dropped, not rendered", () => {
		expect(formatQuestionAnswer(makeAnswer({ notes: "   " }))).toBe("Which library? → Bun");
		expect(formatQuestionAnswer(makeAnswer({}))).toBe("Which library? → Bun");
	});
});

describe("buildQuestionnaireResponse model-facing content", () => {
	test("user notes are visible in LLM content, not only in details", () => {
		const result: QuestionnaireResult = {
			answers: [makeAnswer({ notes: "only if it supports workspaces" })],
			cancelled: false,
		};
		const { content, details } = buildQuestionnaireResponse(result, makeParams());
		expect(content[0]?.text).toContain("[Library] Which library? → Bun");
		expect(content[0]?.text).toContain("— note: only if it supports workspaces");
		expect(details.answers[0]?.notes).toBe("only if it supports workspaces");
	});

	test("header prefix is omitted when the question has no header", () => {
		const params = makeParams();
		params.questions[0].header = "";
		const result: QuestionnaireResult = { answers: [makeAnswer()], cancelled: false };
		const { content } = buildQuestionnaireResponse(result, params);
		expect(content[0]?.text).toStartWith("Which library? →");
	});

	test("cancelled with no answers reports cancellation only", () => {
		const result: QuestionnaireResult = { answers: [], cancelled: true };
		const { content } = buildQuestionnaireResponse(result, makeParams());
		expect(content[0]?.text).toBe("The user cancelled the questionnaire.");
	});

	test("cancelled with partial answers keeps the answers plus the cancellation line", () => {
		const result: QuestionnaireResult = {
			answers: [makeAnswer({ notes: "partial" })],
			cancelled: true,
		};
		const { content } = buildQuestionnaireResponse(result, makeParams());
		expect(content[0]?.text).toContain("Which library? → Bun — note: partial");
		expect(content[0]?.text).toContain("(the user cancelled before completing");
	});
});
