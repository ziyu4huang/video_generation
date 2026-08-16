/**
 * TabBar — horizontal tab strip for multi-question mode.
 * Ported from rpiv-ask-user-question view/components/tab-bar.ts.
 */
import { type Theme } from "@earendil-works/pi-coding-agent";
import type { StatefulView } from "../stateful-view.js";

export interface TabItem {
	label: string;
	active: boolean;
	answered: boolean;
}

export interface TabBarProps {
	tabs: TabItem[];
}

export class TabBar implements StatefulView<TabBarProps> {
	private readonly theme: Theme;
	private props: TabBarProps = { tabs: [] };

	constructor(theme: Theme) {
		this.theme = theme;
	}

	setProps(props: TabBarProps): void {
		this.props = props;
	}

	render(_width: number): string[] {
		const parts = this.props.tabs.map((tab, _i) => {
			const answered = tab.answered ? " ✔" : "";
			return tab.active
				? this.theme.fg("accent", this.theme.bold(`[${tab.label}${answered}]`))
				: ` ${tab.label}${answered} `;
		});
		return [parts.join(" ")];
	}

	invalidate(): void {}
}
