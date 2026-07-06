/**
 * DialogView — the top-level dialog component.
 * Ported from rpiv-ask-user-question view/dialog-builder.ts.
 *
 * Stripped of @juicesharp/rpiv-i18n — all hint strings are inline English.
 */
import { type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Input, Spacer } from "@earendil-works/pi-tui";
import type { QuestionnaireState } from "../state/state.js";
import type { QuestionData } from "../tool/types.js";
import type { PreviewPaneProps } from "./components/preview/preview-pane.js";
import type { TabBar } from "./components/tab-bar.js";
import type { StatefulView } from "./stateful-view.js";
import type { TabComponents } from "./tab-components.js";
import { QuestionTabStrategy, SubmitTabStrategy, type TabContentStrategy } from "./tab-content-strategy.js";

export const HINT_PART_ENTER = "Enter to select";
export const HINT_PART_NAV = "↑/↓ to navigate";
export const HINT_PART_TOGGLE = "Space to toggle";
export const HINT_PART_NOTES = "n to add notes";
export const HINT_PART_TAB = "Tab to switch questions";
export const HINT_PART_CANCEL = "Esc to cancel";
export const HINT_PART_COLLAPSE = "Ctrl+] to collapse";
export const HINT_PART_EXPAND = "Ctrl+] to expand";
export const HINT_SINGLE = [HINT_PART_ENTER, HINT_PART_NAV, HINT_PART_CANCEL].join(" · ");
export const HINT_MULTI = [HINT_PART_ENTER, HINT_PART_NAV, HINT_PART_TAB, HINT_PART_CANCEL].join(" · ");
export const HINT_MULTISELECT_SUFFIX = ` · ${HINT_PART_TOGGLE}`;
export const HINT_NOTES_SUFFIX = ` · ${HINT_PART_NOTES}`;
export const COLLAPSED_HINT = [HINT_PART_EXPAND, HINT_PART_CANCEL].join(" · ");
export const REVIEW_HEADING = "Review your answers";
export const READY_PROMPT = "Ready to submit your answers?";
export const INCOMPLETE_WARNING_PREFIX = "⚠ Answer remaining questions before submitting:";

/** Per-tick projection of dialog state. */
export interface DialogProps {
	state: DialogState;
	activePreviewPane: StatefulView<PreviewPaneProps>;
}

export type DialogState = QuestionnaireState;

export interface DialogConfig {
	theme: Theme;
	questions: readonly QuestionData[];
	tabBar: TabBar | undefined;
	notesInput: Input;
	isMulti: boolean;
	tabsByIndex: ReadonlyArray<TabComponents>;
	submitPicker?: Component;
	getBodyHeight: (width: number) => number;
	getCurrentBodyHeight: (width: number) => number;
	getTerminalRows: () => number;
}

export class DialogView implements StatefulView<DialogProps> {
	private liveProps: DialogProps;
	private readonly config: DialogConfig;
	private readonly questionStrategy: TabContentStrategy;
	private readonly submitStrategy: TabContentStrategy | undefined;

	constructor(config: DialogConfig, initialProps: DialogProps) {
		this.config = config;
		this.liveProps = initialProps;
		this.questionStrategy = new QuestionTabStrategy({
			render: (w: number) => this.renderQuestionBody(w),
			invalidate: () => {},
		});
		this.submitStrategy = config.isMulti
			? new SubmitTabStrategy({
					render: (w: number) => this.renderSubmitBody(w),
					invalidate: () => {},
				})
			: undefined;
	}

	setProps(props: DialogProps): void {
		this.liveProps = props;
	}

	render(width: number): string[] {
		const state = this.liveProps.state;
		const lines: string[] = [];

		// Header: question or review heading
		if (state.currentTab < this.config.questions.length) {
			const q = this.config.questions[state.currentTab];
			const header = q?.header ?? "";
			if (header) lines.push(this.config.theme.bold(`${header}: ${q?.question ?? ""}`));
		} else {
			lines.push(this.config.theme.bold(REVIEW_HEADING));
		}

		// Tab bar (multi-question mode)
		if (this.config.tabBar) {
			lines.push(...this.config.tabBar.render(width));
		}

		// Body
		const bodyLines = this.renderBody(state, width);
		lines.push(...bodyLines);

		// Footer with keybindings
		const footer = this.buildHintText(state);
		if (footer) lines.push(this.config.theme.fg("dim", footer));

		return lines;
	}

	invalidate(): void {}

	private renderBody(state: DialogState, width: number): string[] {
		if (state.currentTab < this.config.questions.length) {
			return this.questionStrategy.renderBody(width);
		}
		return this.submitStrategy?.renderBody(width) ?? [];
	}

	private renderQuestionBody(width: number): string[] {
		const tabIdx = this.liveProps.state.currentTab;
		const tab = this.config.tabsByIndex[tabIdx];
		if (!tab) return [];
		// Render the option list and preview pane
		return tab.optionList.render(width);
	}

	private renderSubmitBody(width: number): string[] {
		const lines: string[] = [];
		lines.push("");
		lines.push(READY_PROMPT);
		// Check for unanswered questions
		const unanswered: string[] = [];
		for (let i = 0; i < this.config.questions.length; i++) {
			if (!this.liveProps.state.answers.has(i)) {
				unanswered.push(this.config.questions[i]?.header ?? `Q${i + 1}`);
			}
		}
		if (unanswered.length > 0) {
			lines.push(this.config.theme.fg("warning", `${INCOMPLETE_WARNING_PREFIX} ${unanswered.join(", ")}`));
		}
		lines.push("");
		if (this.config.submitPicker) {
			lines.push(...this.config.submitPicker.render(width));
		}
		return lines;
	}

	private buildHintText(state: DialogState): string {
		if (state.notesVisible) return `${HINT_PART_ENTER} / ${HINT_PART_CANCEL}`;
		const isMulti = this.config.isMulti;
		const onSubmitTab = isMulti && state.currentTab >= this.config.questions.length;
		if (onSubmitTab) return `${HINT_PART_NAV} · ${HINT_PART_TAB} · Enter to submit · Esc to cancel`;
		if (state.inputMode) return `${HINT_PART_ENTER} · ↑/↓ · Esc`;
		const hintParts = [HINT_PART_ENTER, HINT_PART_NAV];
		if (isMulti) hintParts.push(HINT_PART_TAB);
		if (state.focusedOptionHasPreview) hintParts.push(`n ${HINT_PART_NOTES}`);
		hintParts.push(HINT_PART_CANCEL);
		return hintParts.join(" · ");
	}
}
