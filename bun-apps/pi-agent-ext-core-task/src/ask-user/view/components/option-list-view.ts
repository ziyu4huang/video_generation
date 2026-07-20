/**
 * OptionListView — wraps WrappingSelect as a stateful view.
 * Ported from rpiv-ask-user-question view/components/option-list-view.ts.
 */
import type { WrappingSelectItem } from "./wrapping-select.js";
import { WrappingSelect, type WrappingSelectTheme } from "./wrapping-select.js";
import type { StatefulView } from "../stateful-view.js";

const DEFAULT_MAX_VISIBLE = 8;

export interface OptionListViewProps {
	items?: readonly WrappingSelectItem[];
	selectedIndex?: number;
	focused?: boolean;
	inputBuffer?: string;
}

export class OptionListView implements StatefulView<OptionListViewProps> {
	private readonly select: WrappingSelect;

	constructor(options: { items: readonly WrappingSelectItem[]; theme: WrappingSelectTheme }) {
		this.select = new WrappingSelect(options.items, DEFAULT_MAX_VISIBLE, options.theme);
	}

	setProps(props: OptionListViewProps): void {
		this.select.setSelectedIndex(props.selectedIndex ?? 0);
		this.select.setFocused(props.focused ?? true);
		this.select.setInputBuffer(props.inputBuffer ?? "");
	}

	render(width: number): string[] {
		return this.select.render(width);
	}

	invalidate(): void {
		this.select.invalidate();
	}

	focusedItemRowRange(width: number): [number, number] {
		return this.select.focusedItemRowRange(width);
	}
}
