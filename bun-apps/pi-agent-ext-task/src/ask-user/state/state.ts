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
	collapsed: boolean;
}

/**
 * Per-tick context the dispatcher needs alongside canonical state.
 *
 * The two `*Buffer` fields are text being edited inside a pi-tui `Input`. That
 * widget owns its own cursor and keystroke handling, so the reducer cannot be
 * its source of truth — it can only read the value at the moment it needs it.
 * `notesBuffer` lives here for the same reason `inputBuffer` always has:
 * `state.notesDraft` used to claim the field, and `QuestionnaireSession` kept
 * the claim honest by copying `notesInput.getValue()` back into state after
 * every commit — a round trip that made the "canonical" state a mirror of the
 * view for exactly one field. (Ticket 02 · A8.)
 */
export interface QuestionnaireRuntime {
	keybindings: { matches(data: string, name: string): boolean };
	inputBuffer: string;
	notesBuffer: string;
	questions: readonly QuestionData[];
	isMulti: boolean;
	currentItem: WrappingSelectItem | undefined;
	items: readonly WrappingSelectItem[];
	collapseKey: string;
}
