/**
 * DialogView — the top-level dialog component.
 * Ported from rpiv-ask-user-question view/dialog-builder.ts.
 *
 * Stripped of @juicesharp/rpiv-i18n — all hint strings are inline English.
 */
import { type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Input, Spacer, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { QuestionnaireState } from "../state/state.js";
import type { QuestionData } from "../tool/types.js";
import type { PreviewPaneProps } from "./components/preview/preview-pane.js";
import type { TabBar } from "./components/tab-bar.js";
import type { StatefulView } from "./stateful-view.js";
import type { TabComponents } from "./tab-components.js";
import { QuestionTabStrategy, SubmitTabStrategy, type TabContentStrategy } from "./tab-content-strategy.js";
import { buildHintText, type HintMode } from "./hint-table.js";
import { formatKeySpec } from "../config.js";
// Chrome literals are routed through t() at their render sites. The heading
// consts below stay as English strings (source of truth / dictionary keys) and
// every render site wraps the const in t(); under the default `en` locale t() is
// identity, so output is byte-identical to the un-localized form.
import { t } from "../state/i18n-bridge.js";

// The footer keybinding vocabulary lives in ./hint-table.js — one table, one
// renderer. It used to live here as a pile of HINT_PART_* constants that
// `buildHintText` was free to ignore or re-spell; see that file's header for the
// four defects that grew in the gap.
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
	/**
	 * Resolved collapse-key spec (`resolveCollapseKey`'s output, e.g. `ctrl+]` or
	 * the `off` sentinel). Threaded in so the footer names the key the router
	 * actually matches, instead of a hard-coded one.
	 */
	collapseKey: string;
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
			if (header) {
				// Word-wrap header+question so long questions stay fully visible.
				// Previously this was a single line that overflowed/truncated at
				// the terminal width, hiding the tail of long questions. Every
				// other text surface (options/descriptions/preview) already used
				// wrapTextWithAnsi — only this header line was missed.
				const wrapped = wrapTextWithAnsi(`${header}: ${q?.question ?? ""}`, width);
				for (const segment of wrapped) lines.push(this.config.theme.bold(segment));
			}
		} else {
			lines.push(this.config.theme.bold(t(REVIEW_HEADING)));
		}

		// Tab bar (multi-question mode)
		if (this.config.tabBar) {
			lines.push(...this.config.tabBar.render(width));
		}

		// Body
		const bodyLines = this.renderBody(state, width);
		lines.push(...bodyLines);

		// Footer with keybindings — word-wrap so the whole hint stays
		// visible on narrow terminals (previously a single overflowing line).
		const footer = this.buildHintText(state);
		if (footer) {
			for (const segment of wrapTextWithAnsi(footer, width)) {
				lines.push(this.config.theme.fg("dim", segment));
			}
		}

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
		// Multi-select questions render the checkbox view ([✔] rows + Next sentinel)
		// so the user can SEE toggled state. The plain optionList has no checkbox
		// affordance — rendering it for multiSelect left toggles with zero visual
		// feedback (the user could not tell anything was selected).
		const question = this.config.questions[tabIdx];
		if (question?.multiSelect && tab.multiSelect) {
			return tab.multiSelect.render(width);
		}
		return tab.optionList.render(width);
	}

	private renderSubmitBody(width: number): string[] {
		const lines: string[] = [];
		lines.push("");
		lines.push(t(READY_PROMPT));
		// Check for unanswered questions
		const unanswered: string[] = [];
		for (let i = 0; i < this.config.questions.length; i++) {
			if (!this.liveProps.state.answers.has(i)) {
				unanswered.push(this.config.questions[i]?.header ?? `Q${i + 1}`);
			}
		}
		if (unanswered.length > 0) {
			lines.push(this.config.theme.fg("warning", `${t(INCOMPLETE_WARNING_PREFIX)} ${unanswered.join(", ")}`));
		}
		lines.push("");
		if (this.config.submitPicker) {
			lines.push(...this.config.submitPicker.render(width));
		}
		return lines;
	}

	/**
	 * Which footer applies. Checked in precedence order: an open overlay (notes)
	 * wins over the tab it covers, the submit tab is only reachable in multi
	 * mode, and inputMode is a state OF a question tab.
	 */
	private hintMode(state: DialogState): HintMode {
		if (state.notesVisible) return "notes";
		if (this.config.isMulti && state.currentTab >= this.config.questions.length) return "submit";
		if (state.inputMode) return "input";
		return "question";
	}

	private buildHintText(state: DialogState): string {
		const focusedQuestion =
			state.currentTab < this.config.questions.length ? this.config.questions[state.currentTab] : undefined;
		const focusedIsMultiSelect = Boolean(focusedQuestion?.multiSelect);
		return buildHintText({
			mode: this.hintMode(state),
			isMulti: this.config.isMulti,
			focusedIsMultiSelect,
			// Mirrors key-router.ts's gate (`!multiSelect &&
			// focusedOptionHasPreview`) in full. The multiSelect half is currently
			// redundant — computeFocusedOptionHasPreview already returns false for
			// a multiSelect question — but stating the whole rule here keeps the
			// footer's promise self-contained instead of depending on a derivation
			// two modules away to keep holding.
			notesAvailable: state.focusedOptionHasPreview && !focusedIsMultiSelect,
			collapseKey: formatKeySpec(this.config.collapseKey),
		});
	}
}
