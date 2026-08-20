/**
 * ask-user-question — Pi extension. Registers the `ask_user_question`
 * tool: a structured option selector with a free-text "Other" fallback.
 *
 * Ported from @juicesharp/rpiv-ask-user-question.
 *
 * Stripped of:
 * - @juicesharp/rpiv-config (inlined into config.ts)
 * - @juicesharp/rpiv-i18n (all strings are inline English via i18n-bridge.ts)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import { registerAskUserQuestionReconciler } from "./reconcile.js";

export {
	ASK_USER_PROMPT_EVENT,
	type AskUserPromptEventPayload,
	type AskUserPromptOption,
	type AskUserPromptQuestion,
} from "./events.js";

export default function (pi: ExtensionAPI) {
	registerAskUserQuestionTool(pi);
	registerAskUserQuestionReconciler(pi);
}
