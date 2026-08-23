/**
 * MultiSelectView — checkbox rows with all/next sentinel.
 * Ported from rpiv-ask-user-question view/components/multi-select-view.ts.
 */
import { type Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { StatefulView } from "../stateful-view.js";
import type { QuestionData } from "../../tool/types.js";
// Stage 3b: route chrome literals through t() at their render sites. The
// `Next` default (nextLabel) and the `Type something.` free-text placeholder
// are dictionary keys; under the default `en` locale t() is identity, so this
// changes NO existing render output.
import { t } from "../../state/i18n-bridge.js";
import { hasRecommendedSuffix, RECOMMENDED_SUFFIX } from "../../tool/types.js";

export interface MultiSelectRow {
	checked: boolean;
	active: boolean;
}

export interface MultiSelectOtherState {
	active: boolean;
	inputMode: boolean;
	inputBuffer: string;
	inputCursorOffset: number | undefined;
}

export interface MultiSelectViewProps {
	rows: MultiSelectRow[];
	other: MultiSelectOtherState;
	nextActive: boolean;
	nextLabel: string;
}

export class MultiSelectView implements StatefulView<MultiSelectViewProps> {
	private readonly theme: Theme;
	private readonly question: QuestionData;
	private props: MultiSelectViewProps = {
		rows: [],
		other: { active: false, inputMode: false, inputBuffer: "", inputCursorOffset: undefined },
		nextActive: false,
		nextLabel: "Next",
	};

	constructor(theme: Theme, question: QuestionData) {
		this.theme = theme;
		this.question = question;
	}

	setProps(props: MultiSelectViewProps): void {
		this.props = props;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (let i = 0; i < this.props.rows.length; i++) {
			lines.push(...this.renderRow(i, width));
		}
		lines.push(...this.renderOther(width));
		lines.push(...this.renderNext(width));
		return lines;
	}

	focusedItemRowRange(_width: number): [number, number] {
		return [0, 0];
	}

	naturalHeight(_width: number): number {
		return this.props.rows.length + 2;
	}

	invalidate(): void {}

	private renderRow(index: number, width: number): string[] {
		const row = this.props.rows[index];
		if (!row) return [];
		const checkbox = row.checked ? "[✔]" : "[ ]";
		const pointer = row.active ? "❯ " : "  ";
		const prefix = `${pointer}${checkbox} `;
		const opt = this.question.options[index];
		const rawLabel = opt?.label ?? "";
		// CC suffix convention: ⭐ from the suffix, suffix stripped from display
		// only — the stored label (and answer string) keeps it.
		const isRec = hasRecommendedSuffix(rawLabel);
		const label = isRec ? rawLabel.slice(0, rawLabel.length - RECOMMENDED_SUFFIX.length) : rawLabel;
		const star = isRec ? "⭐ " : "";
		const line = `${prefix}${star}${label}`;
		const styled = row.active || row.checked ? this.theme.fg("accent", this.theme.bold(line)) : line;
		return [styled];
	}

	private renderOther(width: number): string[] {
		const o = this.props.other;
		const check = o.inputMode ? "[ ]" : "";
		const pointer = o.active ? "❯ " : "  ";
		const prefix = `${pointer}${check} `;
		if (o.inputMode) {
			const buffer = o.inputBuffer.length > 0 ? o.inputBuffer : "▌";
			return [`${prefix}${buffer}`];
		}
		const label = t("Type something.");
		const styled = o.active ? this.theme.fg("accent", this.theme.bold(`${label}`)) : label;
		return [`${prefix}${styled}`];
	}

	private renderNext(width: number): string[] {
		const pointer = this.props.nextActive ? "❯ " : "  ";
		const label = t(this.props.nextLabel);
		const styled = this.props.nextActive ? this.theme.fg("accent", this.theme.bold(`${pointer}${label}`)) : `${pointer}${label}`;
		return [styled];
	}
}
