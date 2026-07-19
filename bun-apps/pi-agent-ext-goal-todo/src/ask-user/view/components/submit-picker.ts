/**
 * SubmitPicker — submit/cancel picker for the review tab.
 * Ported from rpiv-ask-user-question view/components/submit-picker.ts.
 */
import { type Theme } from "@earendil-works/pi-coding-agent";
import type { StatefulView } from "../stateful-view.js";

export interface SubmitRow {
	active: boolean;
}

export interface SubmitPickerProps {
	rows: SubmitRow[];
}

export class SubmitPicker implements StatefulView<SubmitPickerProps> {
	private readonly theme: Theme;
	private props: SubmitPickerProps = { rows: [] };

	constructor(theme: Theme) {
		this.theme = theme;
	}

	setProps(props: SubmitPickerProps): void {
		this.props = props;
	}

	render(_width: number): string[] {
		const labels = ["Submit", "Cancel"];
		return labels.map((label, i) => {
			const row = this.props.rows[i];
			const pointer = row?.active ? "❯ " : "  ";
			const line = `${pointer}${label}`;
			return row?.active ? this.theme.fg("accent", this.theme.bold(line)) : line;
		});
	}

	invalidate(): void {}
}
