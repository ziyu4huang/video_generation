/**
 * Focus-aware selector: resolves which view tab is currently active.
 * Ported from rpiv-ask-user-question state/selectors/focus.ts.
 */
import type { QuestionnaireState } from "../state.js";

/**
 * Resolve the active view kind. Returns:
 * - `"question"` when a question tab is focused
 * - `"submit"` when the submit/review tab is focused
 */
export type ActiveView = "question" | "submit";

export function selectActiveView(state: QuestionnaireState, totalQuestions: number): ActiveView {
	return state.currentTab >= totalQuestions ? "submit" : "question";
}
