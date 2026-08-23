/**
 * Tool parameter types, schemas, and envelope interfaces for ask_user_question.
 * Ported from rpiv-ask-user-question tool/types.ts.
 *
 * Stripped of @juicesharp/rpiv-config imports — LABELS_BY_KIND and
 * RESERVED_LABEL_SET sourced from local row-intent.ts instead.
 */
import { type Static, Type } from "typebox";
import { LABELS_BY_KIND, RESERVED_LABEL_SET, ROW_INTENT_META } from "../state/row-intent.js";

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 12;

/** CC convention: the recommended option carries this label suffix and sits first. */
export const RECOMMENDED_SUFFIX = " (Recommended)";

export function hasRecommendedSuffix(label: string): boolean {
	return label.endsWith(RECOMMENDED_SUFFIX);
}

/**
 * User-facing labels for the three runtime sentinel rows, keyed by their
 * `WrappingSelectItem.kind` discriminator. Sourced from
 * `ROW_INTENT_META` via `LABELS_BY_KIND` (`row-intent.ts`).
 */
export const SENTINEL_LABELS = LABELS_BY_KIND;

export type SentinelKind = keyof typeof SENTINEL_LABELS;
export type SentinelLabel = (typeof SENTINEL_LABELS)[SentinelKind];

/**
 * Labels reserved for Pi-internal sentinels — authoring an option with any
 * of these labels triggers the `reserved_label` runtime guard.
 */
export const RESERVED_LABELS = [
	"Other",
	ROW_INTENT_META.other.label,
	ROW_INTENT_META.next.label,
] as const;
export type ReservedLabel = (typeof RESERVED_LABELS)[number];

export const OptionSchema = Type.Object({
	label: Type.String({
		description:
			"The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.",
	}),
	description: Type.String({
		description:
			"Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
	}),
	preview: Type.Optional(
		Type.String({
			description:
				"Optional preview content, rendered as markdown in a monospace box next to the options (side-by-side layout). Use for ASCII mockups of UI layouts or components, code snippets, diagrams, graphs, or configuration examples. Only supported for single-select questions.",
		}),
	),
});

export const QuestionSchema = Type.Object({
	question: Type.String({
		description:
			'The complete question to ask the user. Should be clear, specific, and end with a question mark.',
	}),
	header: Type.String({
		maxLength: MAX_HEADER_LENGTH,
		description: `Very short label displayed as a chip/tag next to the question. Max ${MAX_HEADER_LENGTH} characters. Examples: "Auth method", "Library".`,
	}),
	options: Type.Array(OptionSchema, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description:
			"The available choices for this question. Must have 2-4 options.",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			default: false,
			description:
				"Set to true to allow the user to select multiple options instead of just one. Use for questions where multiple answers are valid; phrase the question accordingly. Do not use for mutually exclusive choices.",
		}),
	),
});

export const QuestionsSchema = Type.Array(QuestionSchema, {
	minItems: 1,
	maxItems: MAX_QUESTIONS,
	description: "Questions to ask the user (1-4 questions)",
});

export const QuestionParamsSchema = Type.Object({
	questions: QuestionsSchema,
});

export type OptionData = Static<typeof OptionSchema>;
export type QuestionData = Static<typeof QuestionSchema>;
export type QuestionParams = Static<typeof QuestionParamsSchema>;

/**
 * Answer-intent discriminated union. `kind` is the single discriminator.
 */
export interface QuestionAnswer {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "multi";
	answer: string | null;
	selected?: string[];
	notes?: string;
	preview?: string;
}

export type QuestionnaireError =
	| "no_ui"
	| "no_custom_ui"
	| "no_questions"
	| "empty_options"
	| "too_many_questions"
	| "duplicate_question"
	| "duplicate_option_label"
	| "reserved_label"
	| "too_many_recommended"
	| "preview_on_multiselect"
	| "header_too_long";

export interface QuestionnaireResult {
	answers: QuestionAnswer[];
	cancelled: boolean;
	error?: QuestionnaireError;
}

export function isQuestionnaireResult(value: unknown): value is QuestionnaireResult {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.answers) && typeof v.cancelled === "boolean";
}
