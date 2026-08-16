/**
 * Keystroke router — maps raw terminal input → QuestionnaireAction.
 * Ported from rpiv-ask-user-question state/key-router.ts.
 */
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { QuestionAnswer } from "../tool/types.js";
import { ROW_INTENT_META } from "./row-intent.js";
import type { QuestionnaireRuntime, QuestionnaireState } from "./state.js";

const KEYBIND_UP = "tui.select.up";
const KEYBIND_DOWN = "tui.select.down";
const KEYBIND_CONFIRM = "tui.select.confirm";
const KEYBIND_CANCEL = "tui.select.cancel";

const NOTES_ACTIVATE_KEY = "n";
const SPACE_KEY = " ";

export type QuestionnaireAction =
	| { kind: "nav"; nextIndex: number }
	| { kind: "tab_switch"; nextTab: number }
	| { kind: "confirm"; answer: QuestionAnswer; autoAdvanceTab?: number }
	| { kind: "toggle"; index: number }
	| { kind: "multi_confirm"; selected: string[]; autoAdvanceTab?: number }
	| { kind: "cancel" }
	| { kind: "notes_enter" }
	// Carries the editor's text: the notes `Input` owns the buffer, so the value
	// travels with the action instead of being mirrored into state. See
	// QuestionnaireRuntime.notesBuffer.
	| { kind: "notes_exit"; value: string }
	| { kind: "submit" }
	| { kind: "submit_nav"; nextIndex: 0 | 1 }
	| { kind: "notes_forward"; data: string }
	| { kind: "toggle_collapsed" }
	| { kind: "ignore" };

export function wrapTab(index: number, total: number): number {
	if (total <= 0) return 0;
	return ((index % total) + total) % total;
}

export function allAnswered(state: QuestionnaireState, runtime: QuestionnaireRuntime): boolean {
	if (runtime.questions.length === 0) return false;
	for (let i = 0; i < runtime.questions.length; i++) {
		if (!state.answers.has(i)) return false;
	}
	return true;
}

function totalTabs(runtime: QuestionnaireRuntime): number {
	return runtime.isMulti ? runtime.questions.length + 1 : 1;
}

function computeAutoAdvanceTab(state: QuestionnaireState, runtime: QuestionnaireRuntime): number | undefined {
	if (!runtime.isMulti) return undefined;
	if (state.currentTab < runtime.questions.length - 1) return state.currentTab + 1;
	return runtime.questions.length;
}

function buildSingleSelectAnswer(state: QuestionnaireState, runtime: QuestionnaireRuntime): QuestionAnswer | null {
	const q = runtime.questions[state.currentTab];
	if (!q) return null;

	const item = runtime.currentItem;

	if (state.inputMode) {
		const label = runtime.inputBuffer;
		return {
			questionIndex: state.currentTab,
			question: q.question,
			kind: "custom",
			answer: label.length > 0 ? label : null,
		};
	}
	if (!item) return null;
	if (item.kind === "other") return null;
	if (item.kind === "next") return null;
	return {
		questionIndex: state.currentTab,
		question: q.question,
		kind: "option",
		answer: item.label,
	};
}

function buildMultiSelected(state: QuestionnaireState, runtime: QuestionnaireRuntime): string[] {
	const q = runtime.questions[state.currentTab];
	if (!q) return [];
	const out: string[] = [];
	for (let i = 0; i < q.options.length; i++) {
		if (state.multiSelectChecked.has(i)) {
			const label = q.options[i]?.label;
			if (typeof label === "string") out.push(label);
		}
	}
	return out;
}

function tabSwitchAction(
	data: string,
	state: QuestionnaireState,
	runtime: QuestionnaireRuntime,
): QuestionnaireAction | null {
	if (!runtime.isMulti) return null;
	const total = totalTabs(runtime);
	if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
		return { kind: "tab_switch", nextTab: wrapTab(state.currentTab + 1, total) };
	}
	if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
		return { kind: "tab_switch", nextTab: wrapTab(state.currentTab - 1, total) };
	}
	return null;
}

function nextNavOnDown(state: QuestionnaireState, runtime: QuestionnaireRuntime): QuestionnaireAction {
	return { kind: "nav", nextIndex: wrapTab(state.optionIndex + 1, Math.max(1, runtime.items.length)) };
}

function prevNavOnUp(state: QuestionnaireState, runtime: QuestionnaireRuntime): QuestionnaireAction {
	return { kind: "nav", nextIndex: wrapTab(state.optionIndex - 1, Math.max(1, runtime.items.length)) };
}

// ── Rules the VIEW also needs ───────────────────────────────────────────────
// The footer used to restate the router's rules from memory, which is how it
// came to advertise a key the router refused. These two predicates are the
// router's own rules, exported so there is exactly one statement of each.

/** The slice of runtime shape both the router and the footer can supply. */
export interface KeyRuleContext {
	isMulti: boolean;
	questionCount: number;
}

function onSubmitTab(state: QuestionnaireState, ctx: KeyRuleContext): boolean {
	return ctx.isMulti && state.currentTab >= ctx.questionCount;
}

/**
 * Where Esc goes from the current state.
 *
 * Esc used to mean "destroy the questionnaire" from every mode except notes: on
 * a four-question dialog one stray keystroke discarded every answer, with no
 * confirmation and no undo. It is now destructive only where there is nothing
 * to lose or where leaving is the explicit point of the screen:
 *
 *   collapsed   → cancel  (the dialog is already out of the way; Esc dismisses)
 *   notes open  → back    (commit the note, close the editor — unchanged)
 *   input mode  → back    (leave the free-text row, keep the questionnaire)
 *   submit tab  → cancel  (this screen exists to choose Submit or Cancel)
 *   question tab, no answers yet → cancel  (nothing has been said yet)
 *   question tab, ≥1 answer      → review  (land on the submit tab, where
 *                                          Cancel is a deliberate choice — so
 *                                          Esc Esc still quits, in two steps)
 *
 * Single-question sessions never reach `review`: answering one immediately
 * completes the dialog, so `answers` is empty for as long as the tab is on
 * screen. Their Esc is unchanged.
 */
export type EscDestination = "cancel" | "back" | "review";

export function escDestination(state: QuestionnaireState, ctx: KeyRuleContext): EscDestination {
	if (state.collapsed) return "cancel";
	if (state.notesVisible) return "back";
	if (state.inputMode) return "back";
	if (onSubmitTab(state, ctx)) return "cancel";
	return ctx.isMulti && state.answers.size > 0 ? "review" : "cancel";
}

/**
 * Whether `n` opens the notes editor right now.
 *
 * The gate used to be `!q.multiSelect && focusedOptionHasPreview`, which made
 * the reducer's multi-select notes branches (`persistMultiSelectAnswer`,
 * `multiConfirmHandler`) permanently unreachable — they read `notesByTab` for
 * an answer whose tab could never have a note. Tying an annotation affordance to
 * whether the focused option happens to carry a PREVIEW was arbitrary besides:
 * a user may well want to annotate a plain option. Both conditions are gone, so
 * notes are available on any question tab and the existing reducer paths are
 * live. (Ticket 02 · A2.)
 */
export function notesKeyAccepted(state: QuestionnaireState, ctx: KeyRuleContext): boolean {
	if (state.collapsed || state.notesVisible || state.inputMode) return false;
	if (onSubmitTab(state, ctx)) return false;
	return state.currentTab < ctx.questionCount;
}

function ruleContext(runtime: QuestionnaireRuntime): KeyRuleContext {
	return { isMulti: runtime.isMulti, questionCount: runtime.questions.length };
}

/** The action Esc produces, derived from `escDestination`. */
function escAction(state: QuestionnaireState, runtime: QuestionnaireRuntime): QuestionnaireAction {
	switch (escDestination(state, ruleContext(runtime))) {
		case "back":
			// Notes are their own overlay; input mode is a property of the FOCUSED
			// ROW (ROW_INTENT_META.activatesInputMode), so the only way out is to
			// move off that row — which navHandler already does, clearing the input
			// buffer on the way. Questions carry at least MIN_OPTIONS real rows
			// above the free-text one, so there is always somewhere to land.
			return state.notesVisible
				? { kind: "notes_exit", value: runtime.notesBuffer }
				: prevNavOnUp(state, runtime);
		case "review":
			return { kind: "tab_switch", nextTab: runtime.questions.length };
		default:
			return { kind: "cancel" };
	}
}

export function routeKey(
	data: string,
	state: QuestionnaireState,
	runtime: QuestionnaireRuntime,
): QuestionnaireAction {
	const kb = runtime.keybindings;

	if (runtime.collapseKey !== "off" && matchesKey(data, runtime.collapseKey as Parameters<typeof matchesKey>[1])) {
		return { kind: "toggle_collapsed" };
	}

	if (state.collapsed) {
		if (kb.matches(data, KEYBIND_CANCEL)) return escAction(state, runtime);
		return { kind: "ignore" };
	}

	if (state.notesVisible) {
		if (kb.matches(data, KEYBIND_CANCEL)) return escAction(state, runtime);
		if (kb.matches(data, KEYBIND_CONFIRM)) return { kind: "notes_exit", value: runtime.notesBuffer };
		return { kind: "notes_forward", data };
	}

	if (state.inputMode) {
		if (kb.matches(data, KEYBIND_CONFIRM)) {
			const answer = buildSingleSelectAnswer(state, runtime);
			if (!answer) return { kind: "ignore" };
			return { kind: "confirm", answer, autoAdvanceTab: computeAutoAdvanceTab(state, runtime) };
		}
		if (kb.matches(data, KEYBIND_CANCEL)) return escAction(state, runtime);
		if (kb.matches(data, KEYBIND_UP)) {
			return prevNavOnUp(state, runtime);
		}
		if (kb.matches(data, KEYBIND_DOWN)) {
			return nextNavOnDown(state, runtime);
		}
		return { kind: "ignore" };
	}

	if (runtime.isMulti && state.currentTab === runtime.questions.length) {
		if (kb.matches(data, KEYBIND_CANCEL)) return escAction(state, runtime);
		const tab = tabSwitchAction(data, state, runtime);
		if (tab) return tab;
		if (kb.matches(data, KEYBIND_UP) || kb.matches(data, KEYBIND_DOWN)) {
			const delta = kb.matches(data, KEYBIND_DOWN) ? 1 : -1;
			const next = wrapTab(state.submitChoiceIndex + delta, 2);
			return { kind: "submit_nav", nextIndex: (next === 1 ? 1 : 0) as 0 | 1 };
		}
		if (kb.matches(data, KEYBIND_CONFIRM)) {
			return state.submitChoiceIndex === 1 ? { kind: "cancel" } : { kind: "submit" };
		}
		return { kind: "ignore" };
	}

	const tab = tabSwitchAction(data, state, runtime);
	if (tab) return tab;

	const q = runtime.questions[state.currentTab];
	if (!q) return { kind: "ignore" };

	// A2: no longer gated on `!multiSelect && focusedOptionHasPreview` — see
	// notesKeyAccepted() above for why. The predicate is the rule; this call site
	// and the footer both read it.
	if (data === NOTES_ACTIVATE_KEY && notesKeyAccepted(state, ruleContext(runtime))) {
		return { kind: "notes_enter" };
	}

	if (kb.matches(data, KEYBIND_UP)) {
		return prevNavOnUp(state, runtime);
	}
	if (kb.matches(data, KEYBIND_DOWN)) {
		return nextNavOnDown(state, runtime);
	}

	if (q.multiSelect) {
		const focusedKind = runtime.currentItem?.kind;
		const focusedMeta = focusedKind ? ROW_INTENT_META[focusedKind] : undefined;

		if (data === SPACE_KEY) {
			if (focusedMeta?.blocksMultiToggle) return { kind: "ignore" };
			if (focusedMeta?.activatesInputMode) return { kind: "ignore" };
			return { kind: "toggle", index: state.optionIndex };
		}
		if (kb.matches(data, KEYBIND_CONFIRM)) {
			if (focusedMeta?.activatesInputMode) return { kind: "ignore" };
			if (!focusedMeta?.autoSubmitsInMulti) return { kind: "toggle", index: state.optionIndex };
			return {
				kind: "multi_confirm",
				selected: buildMultiSelected(state, runtime),
				autoAdvanceTab: computeAutoAdvanceTab(state, runtime),
			};
		}
		if (kb.matches(data, KEYBIND_CANCEL)) return escAction(state, runtime);
		return { kind: "ignore" };
	}

	if (kb.matches(data, KEYBIND_CONFIRM)) {
		const answer = buildSingleSelectAnswer(state, runtime);
		if (!answer) return { kind: "ignore" };
		return { kind: "confirm", answer, autoAdvanceTab: computeAutoAdvanceTab(state, runtime) };
	}
	if (kb.matches(data, KEYBIND_CANCEL)) return escAction(state, runtime);
	return { kind: "ignore" };
}
