/**
 * QuestionnaireSession — runtime state machine for the questionnaire dialog.
 * Ported from rpiv-ask-user-question state/questionnaire-session.ts.
 *
 * Stripped of @juicesharp/rpiv-i18n — English fallback via i18n-bridge.ts.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Input, type OverlayHandle } from "@earendil-works/pi-tui";
import type { QuestionData, QuestionnaireResult, QuestionParams } from "../tool/types.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";
import { buildHintText } from "../view/hint-table.js";
import { formatKeySpec } from "../config.js";
import type { QuestionnairePropsAdapter } from "../view/props-adapter.js";
import { buildQuestionnaire } from "./build-questionnaire.js";
import { t } from "./i18n-bridge.js";
import { type QuestionnaireAction, routeKey } from "./key-router.js";
import { computeFocusedOptionHasPreview } from "./selectors/derivations.js";
import type { QuestionnaireRuntime, QuestionnaireState } from "./state.js";
import { type ApplyContext, type Effect, reduce } from "./state-reducer.js";

const CURSOR_END = "\x05";

export interface QuestionnaireSessionConfig {
	tui: { terminal: { columns: number; rows: number }; requestRender(): void };
	theme: Theme;
	params: QuestionParams;
	itemsByTab: WrappingSelectItem[][];
	done: (result: QuestionnaireResult) => void;
	collapseKey: string;
}

export interface QuestionnaireSessionComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

function initialState(): QuestionnaireState {
	return {
		currentTab: 0,
		optionIndex: 0,
		inputMode: false,
		notesVisible: false,
		answers: new Map(),
		multiSelectChecked: new Set(),
		notesByTab: new Map(),
		focusedOptionHasPreview: false,
		submitChoiceIndex: 0,
		notesDraft: "",
		collapsed: false,
	};
}

export class QuestionnaireSession {
	private state: QuestionnaireState = initialState();

	private readonly questions: readonly QuestionData[];
	private readonly isMulti: boolean;
	private readonly itemsByTab: WrappingSelectItem[][];

	private readonly notesInput: Input;
	private readonly inlineInput: Input;
	private readonly viewAdapter: QuestionnairePropsAdapter;
	private readonly collapseKey: string;

	private overlayHandle: OverlayHandle | undefined;

	private readonly tui: QuestionnaireSessionConfig["tui"];
	private readonly done: QuestionnaireSessionConfig["done"];
	readonly component: QuestionnaireSessionComponent;

	constructor(config: QuestionnaireSessionConfig) {
		this.tui = config.tui;
		this.done = config.done;
		this.questions = config.params.questions;
		this.isMulti = this.questions.length > 1;
		this.itemsByTab = config.itemsByTab;
		this.collapseKey = config.collapseKey;
		this.state = { ...this.state, focusedOptionHasPreview: computeFocusedOptionHasPreview(this.questions, 0, 0) };

		const built = buildQuestionnaire({
			tui: this.tui,
			theme: config.theme,
			questions: this.questions,
			itemsByTab: this.itemsByTab,
			isMulti: this.isMulti,
			initialState: this.state,
			getCurrentTab: () => this.state.currentTab,
			collapseKey: this.collapseKey,
		});

		this.notesInput = built.notesInput;
		this.inlineInput = built.inlineInput;
		this.viewAdapter = built.adapter;

		const theme = config.theme;
		// The collapsed bar is the same vocabulary in a different mode, so it goes
		// through the same table rather than hand-joining an EXPAND + CANCEL pair
		// that could (and did) name a key the router does not honour.
		const collapsedHint = buildHintText({
			mode: "collapsed",
			isMulti: this.isMulti,
			focusedIsMultiSelect: false,
			notesAvailable: false,
			collapseKey: formatKeySpec(this.collapseKey),
		});
		const collapsedRender = (_width: number): string[] => [
			theme.fg("dim", ` ${t("hint.expand_line", collapsedHint)} `),
		];

		this.component = {
			render: (width) => (this.state.collapsed ? collapsedRender(width) : built.render(width)),
			invalidate: built.invalidate,
			handleInput: (data) => this.dispatch(data),
		};

		this.viewAdapter.apply(this.state);
	}

	dispatch(data: string): void {
		const action = routeKey(data, this.state, this.runtime());
		if (action.kind === "ignore") {
			this.handleIgnoreInline(data);
			return;
		}
		this.commit(action);
	}

	private commit(action: QuestionnaireAction): void {
		const result = reduce(this.state, action, this.applyContext());
		this.state = result.state;
		for (const effect of result.effects) this.runEffect(effect);
		this.state = this.mirrorNotesDraft(this.state);
		this.viewAdapter.apply(this.state);
	}

	private mirrorNotesDraft(s: QuestionnaireState): QuestionnaireState {
		const draft = this.notesInput.getValue();
		return s.notesDraft === draft ? s : { ...s, notesDraft: draft };
	}

	private runEffect(effect: Effect): void {
		switch (effect.kind) {
			case "set_input_buffer":
				this.inlineInput.setValue(effect.value);
				this.inlineInput.handleInput(CURSOR_END);
				return;
			case "clear_input_buffer":
				this.inlineInput.setValue("");
				return;
			case "set_notes_value":
				this.notesInput.setValue(effect.value);
				return;
			case "set_notes_focused":
				this.notesInput.focused = effect.focused;
				return;
			case "forward_notes_keystroke":
				this.notesInput.handleInput(effect.data);
				return;
			case "set_overlay_hidden":
				this.overlayHandle?.setHidden(effect.hidden);
				return;
			case "done":
				this.done(effect.result);
				return;
		}
	}

	private handleIgnoreInline(data: string): void {
		if (!this.state.inputMode) return;
		this.inlineInput.handleInput(data);
		this.viewAdapter.apply(this.state);
	}

	private runtime(): QuestionnaireRuntime {
		return {
			keybindings: getKeybindings(),
			inputBuffer: this.inlineInput.getValue(),
			questions: this.questions,
			isMulti: this.isMulti,
			currentItem: this.currentItem(),
			items: this.itemsByTab[this.state.currentTab] ?? [],
			collapseKey: this.collapseKey,
		};
	}

	private applyContext(): ApplyContext {
		return {
			questions: this.questions,
			itemsByTab: this.itemsByTab,
		};
	}

	private currentItem(): WrappingSelectItem | undefined {
		const arr = this.itemsByTab[this.state.currentTab] ?? [];
		return this.state.optionIndex < arr.length ? arr[this.state.optionIndex] : undefined;
	}

	setOverlayHandle(handle: OverlayHandle): void {
		this.overlayHandle = handle;
	}

	toggleCollapsedExternal(): void {
		this.commit({ kind: "toggle_collapsed" });
	}
}
