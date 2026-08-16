/**
 * Per-tab component bundle type.
 * Ported from rpiv-ask-user-question view/tab-components.ts.
 */
import type { OptionListView } from "./components/option-list-view.js";
import type { PreviewPane } from "./components/preview/preview-pane.js";
import type { MultiSelectView } from "./components/multi-select-view.js";

export interface TabBodyHeights {
	current: number;
	max: number;
}

export interface TabComponents {
	optionList: OptionListView;
	preview: PreviewPane;
	multiSelect?: MultiSelectView;
	bodyHeights: (width: number) => TabBodyHeights;
}
