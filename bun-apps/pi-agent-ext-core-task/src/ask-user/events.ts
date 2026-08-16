/**
 * Public event contract for ask_user_question (ported from rpiv-ask-user-question).
 *
 * STABILITY POLICY — applies to every event in the `rpiv:*` namespace.
 *
 *   1. Channel names are immutable. Once shipped, never rename.
 *   2. Payload changes are append-only. Listeners MUST tolerate unknown
 *      fields. New fields ship as optional (`?:`).
 *   3. Breaking changes (rename, retype, remove a field; change emission
 *      semantics) require a NEW channel, e.g. `rpiv:ask-user:prompt.v2`,
 *      with dual-emit during a deprecation window.
 *   4. No `version` field inside payloads. Version via channel name only.
 *   5. Payloads must be JSON-safe: primitives, arrays, plain objects.
 *      No Set/Map/Date/class instances — payloads must survive JSON
 *      serialization when listeners forward them across process or
 *      network boundaries.
 *
 * Naming: `rpiv:<package-or-tool>:<phase>`, lowercase, hyphen-separated.
 * Aligns with Pi's `"my-extension:status"` example and UniPi's `unipi:*`.
 */

export const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt" as const;

/**
 * Answer channel (effort webui-present-adoption, spec §C3): an EXTERNAL
 * surface (the webui shell mirror) returns a questionnaire answer. The
 * webui emits it; ask_user_question's execute consumes it and drives the SAME
 * `done` the TUI overlay session uses (first surface to answer wins). Pure
 * string-literal contract — NO cross-package imports in either direction.
 * External answers correlate by `promptId`; first surface (TUI or webui mirror) to answer wins.
 */
export const ASK_USER_ANSWER_EVENT = "rpiv:ask-user:answer" as const;

export interface AskUserPromptEventPayload {
	/** Correlates prompt -> answer. Optional + append-only (stability policy
	 *  §2): listeners on the v1 payload must tolerate its absence. */
	promptId?: string;
	questions: ReadonlyArray<AskUserPromptQuestion>;
}

/** An external surface's answer to {@link ASK_USER_ANSWER_EVENT}. JSON-safe. */
export interface AskUserAnswerEventPayload {
	/** Must match the prompt's promptId; answers for other prompts are ignored. */
	promptId: string;
	/** Same shape the TUI dialog's done() carries (QuestionnaireResult). */
	result: unknown;
}

export interface AskUserPromptQuestion {
	/** The full question text, exactly as the agent authored it. */
	question: string;
	/** The short chip/tag shown next to the question. */
	header: string;
	/** True iff the user may pick multiple options. Normalized from optional. */
	multiSelect: boolean;
	options: ReadonlyArray<AskUserPromptOption>;
}

export interface AskUserPromptOption {
	label: string;
	description: string;
	/** True iff the option carries rich preview content (content not shipped). */
	hasPreview: boolean;
}
