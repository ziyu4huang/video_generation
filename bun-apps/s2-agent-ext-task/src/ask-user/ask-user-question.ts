/**
 * ask_user_question tool — structured questionnaire with TUI overlay.
 * Ported from rpiv-ask-user-question ask-user-question.ts.
 *
 * Stripped of @juicesharp/rpiv-i18n / @juicesharp/rpiv-config — all
 * dependencies inlined or replaced with local modules.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { formatKeySpec, loadConfig, resolveCollapseKey, validateGuidanceFields } from "./config.js";
import {
	ASK_USER_ANSWER_EVENT,
	ASK_USER_ANSWERED_EVENT,
	ASK_USER_PROMPT_EVENT,
	type AskUserAnswerEventPayload,
	type AskUserAnsweredEventPayload,
	type AskUserPromptEventPayload,
} from "./events.js";
import { hasDialogUI, runRpcQuestionnaire } from "./rpc-fallback.js";
import { displayLabel } from "./state/i18n-bridge.js";
import { sentinelsToAppend } from "./state/row-intent.js";
import { buildQuestionnaireResponse, buildToolResult } from "./tool/response-envelope.js";
import {
	hasRecommendedSuffix,
	MAX_OPTIONS,
	MAX_QUESTIONS,
	MIN_OPTIONS,
	type QuestionData,
	type QuestionnaireResult,
	type QuestionParams,
	QuestionParamsSchema,
} from "./tool/types.js";
import { validateQuestionnaire } from "./tool/validate-questionnaire.js";
import type { WrappingSelectItem } from "./view/components/wrapping-select.js";

function emitAskUserPromptEvent(pi: ExtensionAPI, params: QuestionParams): string {
	const promptId = crypto.randomUUID();
	const payload: AskUserPromptEventPayload = {
		promptId,
		questions: params.questions.map((q) => ({
			question: q.question,
			header: q.header,
			multiSelect: q.multiSelect ?? false,
			options: q.options.map((o) => ({
				label: o.label,
				description: o.description,
				hasPreview: typeof o.preview === "string" && o.preview.length > 0,
			})),
		})),
	};
	pi.events.emit(ASK_USER_PROMPT_EVENT, payload);
	return promptId;
}

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

const ERROR_NO_CUSTOM_UI =
	"Error: this client cannot render the questionnaire (custom UI is unavailable, e.g. RPC/ACP hosts such as Zed or Paseo). The user never saw the questions — do NOT treat this as a decline. Ask the questions as plain chat text instead, without using this tool.";

export function buildItemsForQuestion(question: QuestionData): WrappingSelectItem[] {
	const items: WrappingSelectItem[] = question.options.map((o) => ({
		kind: "option",
		label: o.label,
		description: o.description,
		recommended: hasRecommendedSuffix(o.label) ? true : undefined,
	}));
	for (const kind of sentinelsToAppend(question)) {
		items.push({ kind, label: displayLabel(kind) });
	}
	return items;
}

export const DEFAULT_PROMPT_SNIPPET = `Ask the user 1-4 structured questions (2-4 options each) when requirements are ambiguous or a decision is needed`;

export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	`Use when ambiguous (up to ${MAX_QUESTIONS} questions, ${MIN_OPTIONS}-${MAX_OPTIONS} options each). Each option needs a concise label + description. User can type a custom answer or Esc to quit.`,
	"Mark your recommended option by suffixing its label with \"(Recommended)\" and placing it first — at most one per question. Never add any other recommended marker.",
	"multiSelect only when several answers are valid; preview only on single-select questions (markdown, monospace box, side-by-side).",
	"Batch all questions in one call (don't stack). In planning work, clarify BEFORE presenting a plan; never ask \"is the plan ready\" with this tool.",
];

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	pi.registerTool({
		name: ASK_USER_QUESTION_TOOL_NAME,
		gating: { core: true },
		label: "Ask User Question",
		description: `Ask the user 1-4 structured questions to clarify requirements or get decisions. Each question has a short header, 2-4 options (label + description), and the user can always type a custom answer or press Esc to abandon.

Usage notes:
- Users will always be able to type a custom answer ("Type something." row is appended automatically to every question). Do NOT author "Other" / "Type something." labels yourself — duplicates are rejected at runtime.
- If you recommend a specific option, add "(Recommended)" to the end of its label and place it first in the list. At most one per question.
- Use multiSelect: true ONLY when multiple answers are valid; phrase the question accordingly. Do not use it for mutually exclusive choices.
- Preview feature: use the optional \`preview\` field on options when presenting concrete artifacts the user needs to visually compare — mockups, code snippets, diagram variations, config examples. Previews render as markdown in a monospace box with a side-by-side layout, and are only supported for single-select questions.
- Clarify requirements BEFORE finalizing a plan; when a plan-approval flow exists, ask clarifying questions before presenting the plan, and never use this tool to ask "is the plan ready" — that is the plan-approval flow's job.`,
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: QuestionParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typed = params as unknown as QuestionParams;
			if (!ctx.hasUI) return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" });

			const validation = validateQuestionnaire(typed);
			if (!validation.ok) {
				return buildToolResult(validation.message, {
					answers: [],
					cancelled: true,
					error: validation.error,
				});
			}

			const promptId = emitAskUserPromptEvent(pi, typed);

			if ((ctx as { mode?: string }).mode === "rpc" && hasDialogUI(ctx.ui)) {
				return buildQuestionnaireResponse(await runRpcQuestionnaire(ctx.ui, typed), typed);
			}

			const itemsByTab: WrappingSelectItem[][] = typed.questions.map((q) => buildItemsForQuestion(q));

			const { QuestionnaireSession } = await import("./state/questionnaire-session.js");
			const collapseKey = resolveCollapseKey(loadConfig());

			const sessionRef: {
				current: import("./state/questionnaire-session.js").QuestionnaireSession | null;
			} = { current: null };
			const overlayHandleRef: { current: import("@earendil-works/pi-tui").OverlayHandle | undefined } = {
				current: undefined,
			};
			// External answer channel (webui-present-adoption §C3): the webui shell
			// mirror answers via ASK_USER_ANSWER_EVENT. doneRef captures the SAME
			// resolution callback the TUI submit uses — calling it is identical to a
			// keyboard submit (overlay dismisses, promise resolves; null-out =
			// first-answer-wins).
			const doneRef: { current: ((r: QuestionnaireResult) => void) | undefined } = { current: undefined };
			const unsubscribeAnswer = pi.events.on(ASK_USER_ANSWER_EVENT, (payload: unknown) => {
				const p = payload as AskUserAnswerEventPayload | undefined;
				if (!p || p.promptId !== promptId) return;
				const done = doneRef.current;
				if (typeof done !== "function") return;
				doneRef.current = undefined;
				done(p.result as QuestionnaireResult);
			});
			let hasAnnouncedHide = false;
			let removeOverlayInputListener: (() => void) | undefined;

			if (collapseKey !== "off" && typeof ctx.ui.onTerminalInput === "function") {
				removeOverlayInputListener = ctx.ui.onTerminalInput((data) => {
					const handle = overlayHandleRef.current;
					if (!handle) return undefined;
					if (!handle.isHidden() && !handle.isFocused()) return undefined;
					if (!matchesKey(data, collapseKey as Parameters<typeof matchesKey>[1])) return undefined;
					sessionRef.current?.toggleCollapsedExternal();
					if (handle.isHidden() && !hasAnnouncedHide) {
						hasAnnouncedHide = true;
						// Same formatter the footer hint uses — the two used to spell
						// the key differently (`ctrl+]` here, a hard-coded "Ctrl+]"
						// there), which is only invisible while nobody rebinds it.
						ctx.ui.notify?.(`ask_user_question hidden — press ${formatKeySpec(collapseKey)} to reopen`, "info");
					}
					return { consume: true };
				});
			}

			try {
				const result = await ctx.ui.custom<QuestionnaireResult>(
					(tui, theme, _kb, done) => {
						// Capture done FIRST — QuestionnaireSession construction can throw
						// (e.g. a fake tui in tests), and the external answer channel must
						// still be able to resolve execute regardless.
						doneRef.current = done;
						const session = new QuestionnaireSession({
							tui,
							theme,
							params: typed,
							itemsByTab,
							done,
							collapseKey,
						});
						sessionRef.current = session;
						return session.component;
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "bottom-center",
							width: "100%",
							maxHeight: "100%",
							margin: { left: 0, right: 0, bottom: 0 },
						},
						onHandle: (handle) => {
							overlayHandleRef.current = handle;
							sessionRef.current?.setOverlayHandle(handle);
						},
					},
				);

				if (result === undefined) {
					if (hasDialogUI(ctx.ui)) {
						return buildQuestionnaireResponse(await runRpcQuestionnaire(ctx.ui, typed), typed);
					}
					return buildToolResult(ERROR_NO_CUSTOM_UI, { answers: [], cancelled: true, error: "no_custom_ui" });
				}

				return buildQuestionnaireResponse(result, typed);
			} finally {
				removeOverlayInputListener?.();
				unsubscribeAnswer?.();
				// Tombstone (webui-tui-parity C1): retire external mirrors on ANY exit.
				pi.events.emit(ASK_USER_ANSWERED_EVENT, { promptId } satisfies AskUserAnsweredEventPayload);
			}
		},
	});
}

export { buildQuestionnaireResponse, buildToolResult };
