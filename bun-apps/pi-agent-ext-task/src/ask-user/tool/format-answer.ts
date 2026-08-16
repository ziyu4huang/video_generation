/**
 * Format a single QuestionAnswer into a one-line string for the LLM-facing envelope.
 * Ported from rpiv-ask-user-question tool/format-answer.ts.
 */
import type { QuestionAnswer } from "./types.js";

export function formatQuestionAnswer(answer: QuestionAnswer): string {
	switch (answer.kind) {
		case "option":
			return `${answer.question} → ${answer.answer}`;
		case "custom":
			return `${answer.question} → (custom) ${answer.answer ?? "(empty)"}`;
		case "multi": {
			const labels = answer.selected?.join(", ");
			return labels
				? `${answer.question} → [${labels}]`
				: `${answer.question} → (none selected)`;
		}
	}
}
