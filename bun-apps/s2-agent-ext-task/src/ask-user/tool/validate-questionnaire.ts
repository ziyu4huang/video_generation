/**
 * Questionnaire validation — catches bad params before the TUI renders.
 * Ported from rpiv-ask-user-question tool/validate-questionnaire.ts.
 */
import {
	MAX_QUESTIONS,
	MAX_HEADER_LENGTH,
	MIN_OPTIONS,
	MAX_OPTIONS,
	RESERVED_LABELS,
	hasRecommendedSuffix,
	type QuestionParams,
	type QuestionnaireError,
} from "./types.js";

export type ValidationResult =
	| { ok: true }
	| { ok: false; message: string; error: QuestionnaireError };

const RESERVED_SET = new Set(RESERVED_LABELS);

export function validateQuestionnaire(params: QuestionParams): ValidationResult {
	const { questions } = params;

	if (!questions || questions.length === 0) {
		return { ok: false, message: "Error: no questions provided.", error: "no_questions" };
	}

	if (questions.length > MAX_QUESTIONS) {
		return {
			ok: false,
			message: `Error: too many questions (${questions.length}, max ${MAX_QUESTIONS}).`,
			error: "too_many_questions",
		};
	}

	const seenLabels = new Map<string, number>();
	const seenQuestions = new Set<string>();

	for (let qi = 0; qi < questions.length; qi++) {
		const q = questions[qi];
		const opts = q.options;

		// Duplicate question text is ambiguous: answers are keyed by the
		// question's text, so two identical questions would collide.
		const questionKey = q.question?.trim().toLowerCase() ?? "";
		if (questionKey && seenQuestions.has(questionKey)) {
			return {
				ok: false,
				message: `Error: duplicate question text "${q.question}" (question ${qi + 1}).`,
				error: "duplicate_question",
			};
		}
		seenQuestions.add(questionKey);

		if (!opts || opts.length === 0) {
			return { ok: false, message: `Error: question ${qi + 1} has no options.`, error: "empty_options" };
		}

		if (opts.length < MIN_OPTIONS || opts.length > MAX_OPTIONS) {
			return {
				ok: false,
				message: `Error: question ${qi + 1} has ${opts.length} options (need ${MIN_OPTIONS}-${MAX_OPTIONS}).`,
				error: "empty_options",
			};
		}

		// header guard: unvalidated runtime payloads may omit it
		if (q.header && q.header.length > MAX_HEADER_LENGTH) {
			return {
				ok: false,
				message: `Error: question ${qi + 1} header exceeds ${MAX_HEADER_LENGTH} characters.`,
				error: "header_too_long",
			};
		}

		const recommendedCount = opts.filter((o) => o.label && hasRecommendedSuffix(o.label)).length;
		if (recommendedCount > 1) {
			return {
				ok: false,
				message: `Error: question ${qi + 1} has ${recommendedCount} options labeled "(Recommended)" (at most one allowed).`,
				error: "too_many_recommended",
			};
		}

		if (q.multiSelect === true && opts.some((o) => typeof o.preview === "string" && o.preview.length > 0)) {
			return {
				ok: false,
				message: `Error: question ${qi + 1} is multiSelect but has a preview — previews are only supported for single-select questions.`,
				error: "preview_on_multiselect",
			};
		}

		for (let oi = 0; oi < opts.length; oi++) {
			const opt = opts[oi];
			if (!opt.label || opt.label.trim().length === 0) {
				return {
					ok: false,
					message: `Error: question ${qi + 1}, option ${oi + 1} has an empty label.`,
					error: "empty_options",
				};
			}
			const key = `${qi}:${opt.label.toLowerCase().trim()}`;
			if (seenLabels.has(key)) {
				return {
					ok: false,
					message: `Error: duplicate option label "${opt.label}" in question ${qi + 1}.`,
					error: "duplicate_option_label",
				};
			}
			seenLabels.set(key, oi);

			if (RESERVED_SET.has(opt.label.trim())) {
				return {
					ok: false,
					message: `Error: "${opt.label}" is a reserved label and cannot be used as an option. The "Type something." row is appended automatically.`,
					error: "reserved_label",
				};
			}
		}
	}

	return { ok: true };
}
