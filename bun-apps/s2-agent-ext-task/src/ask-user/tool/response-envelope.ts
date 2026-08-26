/**
 * Response envelope builders for ask_user_question.
 * Ported from rpiv-ask-user-question tool/response-envelope.ts.
 */
import type { QuestionAnswer, QuestionData, QuestionnaireResult, QuestionParams } from "./types.js";
import { formatQuestionAnswer } from "./format-answer.js";

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: QuestionnaireResult;
	/** Flag validation/host errors so the model sees a failed call, not an answer (cc-parity t02). */
	isError?: boolean;
}

export function buildToolResult(text: string, details: QuestionnaireResult, isError?: boolean): ToolResult {
	return {
		content: [{ type: "text", text }],
		details,
		...(isError ? { isError: true } : {}),
	};
}

export function buildQuestionnaireResponse(result: QuestionnaireResult, params: QuestionParams): ToolResult {
	if (result.cancelled && result.answers.length === 0) {
		return buildToolResult("The user cancelled the questionnaire.", result);
	}
	const lines: string[] = [];
	for (const answer of result.answers) {
		const q = params.questions[answer.questionIndex];
		const header = q?.header ? `[${q.header}] ` : "";
		lines.push(`${header}${formatQuestionAnswer(answer)}`);
	}
	if (result.cancelled) {
		lines.push("(the user cancelled before completing the questionnaire — use the answers above as partial input)");
	}
	return buildToolResult(lines.join("\n"), result);
}
