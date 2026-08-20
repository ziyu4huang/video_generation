/**
 * State → component-props projections. Pure — no side-effects, no rendering.
 * Ported from rpiv-ask-user-question state/selectors/projections.ts.
 */
import type { QuestionData } from "../../tool/types.js";
import type { DialogProps } from "../../view/dialog-builder.js";
import type { WrappingSelectItem } from "../../view/components/wrapping-select.js";
import type { MultiSelectViewProps } from "../../view/components/multi-select-view.js";
import type { PreviewPaneProps } from "../../view/components/preview/preview-pane.js";
import type { SubmitPickerProps } from "../../view/components/submit-picker.js";
import type { TabBarProps } from "../../view/components/tab-bar.js";
import type { BindingContext, PerTabBindingContext } from "./contract.js";
import type { QuestionnaireState } from "../state.js";
import { selectActivePreviewPaneIndex } from "./derivations.js";

export function selectDialogProps(state: QuestionnaireState, ctx: BindingContext): DialogProps {
	return { state, activePreviewPane: ctx.tabsByIndex[ctx.paneIndex]?.preview! };
}

export function selectSubmitPickerProps(state: QuestionnaireState, ctx: BindingContext): SubmitPickerProps {
	return {
		rows: [
			{ active: state.currentTab >= ctx.questions.length && state.submitChoiceIndex === 0 },
			{ active: state.currentTab >= ctx.questions.length && state.submitChoiceIndex === 1 },
		],
	};
}

export function selectTabBarProps(state: QuestionnaireState, ctx: BindingContext): TabBarProps {
	return {
		tabs: ctx.questions.map((q, i) => ({
			label: q.header,
			active: i === state.currentTab && state.currentTab < ctx.questions.length,
			answered: state.answers.has(i),
		})),
	};
}

export function selectOptionListProps(state: QuestionnaireState, ctx: PerTabBindingContext): Record<string, unknown> {
	const q = ctx.questions[ctx.i];
	if (!q) return {};
	const items = ctx.itemsByTab[ctx.i] as readonly WrappingSelectItem[] | undefined;
	const focused = ctx.i === state.currentTab;
	const selectedIndex = focused ? state.optionIndex : -1;
	return { items, selectedIndex, focused, inputBuffer: ctx.inputBuffer };
}

export function selectPreviewPaneProps(state: QuestionnaireState, ctx: PerTabBindingContext): PreviewPaneProps {
	const totalQuestions = ctx.totalQuestions;
	const isActive = ctx.i === selectActivePreviewPaneIndex(state.currentTab, totalQuestions);
	return { visible: isActive, optionIndex: state.optionIndex, focused: isActive && ctx.i === state.currentTab };
}

export function selectMultiSelectProps(state: QuestionnaireState, ctx: PerTabBindingContext): MultiSelectViewProps {
	const q = ctx.questions[ctx.i] as QuestionData;
	const focused = ctx.i === state.currentTab;
	const rows = q.options.map((_, i) => ({
		checked: state.multiSelectChecked.has(i),
		active: focused && i === state.optionIndex,
	}));
	const otherActive = focused && state.optionIndex === q.options.length;
	const nextActive = focused && state.optionIndex === q.options.length + 1;
	return {
		rows,
		other: {
			active: otherActive,
			inputMode: state.inputMode && otherActive,
			inputBuffer: ctx.inputBuffer,
			inputCursorOffset: undefined,
		},
		nextActive,
		nextLabel: "Next",
	};
}
