/**
 * Pure derived-value selectors.
 * Ported from rpiv-ask-user-question state/selectors/derivations.ts.
 */
import type { QuestionData } from "../../tool/types.js";

/**
 * Which tab's preview pane should be active? When `currentTab < totalQuestions`,
 * the current tab's pane is active. When `currentTab === totalQuestions` (submit tab),
 * the LAST question's pane stays visible so the user can still reference previews
 * while reviewing their answers.
 */
export function selectActivePreviewPaneIndex(currentTab: number, totalQuestions: number): number {
	if (currentTab < totalQuestions) return currentTab;
	return Math.max(0, totalQuestions - 1);
}

/**
 * Does the currently focused option carry a non-empty `preview` string?
 * Derived from the question at `currentTab`, focusing the option at `optionIndex`
 * within that question's option list.
 */
export function computeFocusedOptionHasPreview(
	questions: readonly QuestionData[],
	currentTab: number,
	optionIndex: number,
): boolean {
	const q = questions[currentTab];
	if (!q || q.multiSelect) return false;
	const option = q.options[optionIndex];
	return typeof option?.preview === "string" && option.preview.length > 0;
}
