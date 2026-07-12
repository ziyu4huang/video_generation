/**
 * shared/status-widget.ts — single above-editor widget for power-tool's
 * persistent indicators (goal + todo), rendered in a FIXED order.
 *
 * WHY ONE KEY (not one per feature):
 * The pi-coding-agent SDK stores above-editor widgets in a Map and renders them
 * via `widgets.values()` — i.e. JS Map INSERTION ORDER. There is no order/index
 * API on `setWidget`. Two separate keys (the old "pi-goal" + "rpiv-todos")
 * therefore stack in registration order, and whenever one is cleared
 * (`setWidget(key, undefined)`) and later re-registered it jumps to the END →
 * visible flicker/reorder while a /goal is active with a non-empty todo list.
 *
 * One composite key ("pi-power-tool") makes stacking deterministic by
 * construction: the only above-editor widget can't reorder relative to itself.
 * The sections inside it render in `addSection` order (goal on top, todo below).
 *
 * This is ALSO where all the widget lifecycle lives (setUICtx / register /
 * requestRender / dispose), so GoalOverlay and TodoOverlay no longer duplicate
 * the `widgetRegistered` / `tui` / stale-ctx machinery — they become thin
 * state-holders that expose `render(theme, width)` and call `setRefresh`'s
 * callback when their content changes.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI } from "@earendil-works/pi-tui";

const WIDGET_KEY = "pi-power-tool";

export interface StatusSection {
	/** Stable id (debug/ordering only). */
	id: string;
	/** Render this section's lines. Empty array = section hidden. */
	render(theme: Theme, width: number): string[];
}

export class PowerToolStatusWidget {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private sections: StatusSection[] = [];

	setUICtx(ctx: ExtensionUIContext): void {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	/**
	 * Register a section. Stack order = addSection order (call in the desired
	 * top-to-bottom order; goal first, todo second).
	 */
	addSection(section: StatusSection): void {
		if (!this.sections.some((s) => s.id === section.id)) this.sections.push(section);
	}

	/** Re-render. Call after any section's content changes. */
	update(): void {
		// Non-UI modes (RPC/CLI) have no widget surface — silently no-op.
		if (!this.uiCtx?.setWidget) return;
		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderAll(theme, width),
						invalidate: () => {
							this.widgetRegistered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	dispose(): void {
		this.sections = [];
		if (this.uiCtx?.setWidget) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
	}

	/**
	 * Concatenate non-empty sections, inserting a blank line BETWEEN sections
	 * for visual separation. Trailing/leading spacers are handled by the SDK's
	 * widget container, so sections return only their own content lines.
	 */
	private renderAll(theme: Theme, width: number): string[] {
		const lines: string[] = [];
		for (const section of this.sections) {
			const out = section.render(theme, width);
			if (out.length === 0) continue;
			if (lines.length > 0) lines.push("");
			lines.push(...out);
		}
		return lines;
	}
}
