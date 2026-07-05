/**
 * PreviewLayoutDecider — computes side-by-side vs stacked layout for preview.
 * Ported from rpiv-ask-user-question view/components/preview/preview-layout-decider.ts.
 */
import type { QuestionData } from "../../../tool/types.js";
import type { WrappingSelectItem } from "../wrapping-select.js";

/** Minimum pane width for side-by-side layout. Below this, preview is stacked below options. */
const MIN_SPLIT_PANE_WIDTH = 40;

/** Fraction of the total width allocated to the options (left) pane. */
const LEFT_PANE_FRACTION = 0.35;

export type LayoutKind = "side-by-side" | "stacked";

/**
 * Decide the layout kind based on available width and whether any option has a preview.
 */
export function decideLayout(width: number, hasPreview: boolean): LayoutKind {
	if (!hasPreview) return "stacked";
	if (width < MIN_SPLIT_PANE_WIDTH) return "stacked";
	return "side-by-side";
}

/**
 * Given the total width, compute the left (options) pane width for side-by-side layout.
 */
export function leftPaneWidth(totalWidth: number): number {
	return Math.max(20, Math.floor(totalWidth * LEFT_PANE_FRACTION));
}

/**
 * Compute the global maximum left-pane width across all question tabs, accounting for
 * cross-tab donation. Returns a function that accepts a pane (total) width.
 */
export function crossTabLeftWidthWithDonation(
	tabsDescriptor: ReadonlyArray<{ multiSelect?: boolean }>,
	itemsByTab: ReadonlyArray<readonly WrappingSelectItem[]>,
	_questions: readonly QuestionData[],
	paneWidth: number,
): number {
	// Compute max left width across all tabs
	let max = 0;
	for (let i = 0; i < tabsDescriptor.length; i++) {
		if (tabsDescriptor[i]?.multiSelect) continue; // Multi-select doesn't use side-by-side
		const items = itemsByTab[i] ?? [];
		const leftW = leftPaneWidth(paneWidth);
		max = Math.max(max, leftW);
	}
	return max;
}
