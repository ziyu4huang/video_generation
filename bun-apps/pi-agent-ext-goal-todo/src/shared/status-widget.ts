/**
 * shared/status-widget.ts — single above-editor widget for the composite
 * status display (goal, todo, and now wayfind / planning-with-files),
 * rendered in a FIXED order.
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
 * Sections render sorted by their `order` field (goal=0, todo=1, wayfind=2,
 * planning-with-files=3); sections without an explicit `order` sort after all
 * ordered sections, in `addSection` call order.
 *
 * WHY A `globalThis`-BACKED SINGLETON (not a module-level `let instance`):
 * pi loads extensions via jiti. Module identity across a jiti-loaded extension
 * and a native `import()` of the same package is NOT guaranteed — two
 * "instances" of this module can exist in the same process, each with its own
 * module-level `let instance`, so wayfind and planning-with-files could each
 * get a DIFFERENT widget and silently stop sharing state. `globalThis` is
 * process-singleton → always the same object regardless of which loader
 * resolved this module. Same rationale as the existing
 * `__piWayfindActive` / `__piGoalActive` coordination-seam keys.
 *
 * This is ALSO where all the widget lifecycle lives (setUICtx / register /
 * requestRender / dispose), so GoalOverlay, TodoOverlay, and any consumer
 * package's overlay no longer duplicate the `widgetRegistered` / `tui` /
 * stale-ctx machinery — they become thin state-holders that expose
 * `render(theme, width)` and call `setRefresh`'s callback when their content
 * changes.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI } from "@earendil-works/pi-tui";

const WIDGET_KEY = "pi-power-tool";
const SINGLETON_GLOBAL_KEY = "__piPowerToolStatusWidget";

export interface StatusSection {
	/** Stable id (dedupe + debug/ordering only). */
	id: string;
	/**
	 * Sort key, ascending. Sections sharing an `order` (or all omitting it)
	 * keep `addSection` call order relative to each other. Known assignments:
	 * goal=0, todo=1, wayfind=2, planning-with-files=3.
	 */
	order?: number;
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
	 * Register a section. Render order is by `order` ascending (ties, and
	 * sections without `order`, keep call order). Safe to call once per
	 * package per process — duplicate `id`s are ignored.
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
	 * Sections sorted by `order` ascending (undefined sorts last, stable
	 * relative to addSection order via Array.prototype.sort's stability).
	 * Concatenate non-empty sections, inserting a blank line BETWEEN sections
	 * for visual separation. Trailing/leading spacers are handled by the SDK's
	 * widget container, so sections return only their own content lines.
	 */
	private renderAll(theme: Theme, width: number): string[] {
		const ordered = [...this.sections].sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
		const lines: string[] = [];
		for (const section of ordered) {
			const out = section.render(theme, width);
			if (out.length === 0) continue;
			if (lines.length > 0) lines.push("");
			lines.push(...out);
		}
		return lines;
	}
}

/**
 * Process-singleton accessor. See the class doc comment for why this is
 * `globalThis`-backed rather than a module-level `let instance`. Every
 * package that wants a section on the composite status widget (goal-todo
 * itself, wayfind, planning-with-files) calls this — never `new
 * PowerToolStatusWidget()` directly, or it will get its own disconnected
 * widget instance.
 */
export function getSharedStatusWidget(): PowerToolStatusWidget {
	const g = globalThis as Record<string, unknown>;
	if (!(g[SINGLETON_GLOBAL_KEY] instanceof PowerToolStatusWidget)) {
		g[SINGLETON_GLOBAL_KEY] = new PowerToolStatusWidget();
	}
	return g[SINGLETON_GLOBAL_KEY] as PowerToolStatusWidget;
}
