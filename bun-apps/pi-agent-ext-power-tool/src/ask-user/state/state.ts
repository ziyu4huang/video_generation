/**
 * Canonical state shape for the questionnaire dialog.
 * Ported from rpiv-ask-user-question state/state.ts.
 */
import type { QuestionAnswer, QuestionData } from "../tool/types.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";

/**
 * Canonical state for the questionnaire dialog. Single source of truth — both the
 * dispatcher (`routeKey`) and the view layer read this same shape.
 */
export interface QuestionnaireState {
	currentTab: number;
	optionIndex: number;
	inputMode: boolean;
	notesVisible: boolean;
	answers: ReadonlyMap<number, QuestionAnswer>;
	multiSelectChecked: ReadonlySet<number>;
	notesByTab: ReadonlyMap<number, string>;
	focusedOptionHasPreview: boolean;
	submitChoiceIndex: number;
	notesDraft: string;
	collapsed: boolean;
}

/**
 * Per-tick context the dispatcher needs alongside canonical state.
 */
export interface QuestionnaireRuntime {
	keybindings: { matches(data: string, name: string): boolean };
	inputBuffer: string;
	questions: readonly QuestionData[];
	isMulti: boolean;
	currentItem: WrappingSelectItem | undefined;
	items: readonly WrappingSelectItem[];
	collapseKey: string;
}
