/**
 * shared/status-widget.ts — single above-editor widget for the composite
 * status display (goal, todo, and now wayfind / the plan coordinator),
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
 * the plan coordinator=3); sections without an explicit `order` sort after all
 * ordered sections, in `addSection` call order.
 *
 * WHY A `globalThis`-BACKED SINGLETON (not a module-level `let instance`):
 * pi loads extensions via jiti. Module identity across a jiti-loaded extension
 * and a native `import()` of the same package is NOT guaranteed — two
 * "instances" of this module can exist in the same process, each with its own
 * module-level `let instance`, so wayfind and the plan coordinator could each
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
	 * goal=0, todo=1, wayfind=2, the plan coordinator=3.
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

	/**
	 * Tears down the ENTIRE shared widget — ALL registered sections from
	 * EVERY consumer package are wiped, not just the caller's own. This is
	 * process-wide shared state (see `getSharedStatusWidget`), so only the
	 * package that owns true end-of-session lifecycle should ever call this.
	 * Currently that's `pi-agent-ext-goal-todo` (positioned first in load
	 * order), which calls it exactly once, from its own `session_shutdown`
	 * handler — the point where every extension is tearing down anyway.
	 * Other consumer packages (wayfind, the plan coordinator, ...) must
	 * dispose only their own overlay/section state and must NEVER call this
	 * method on the shared widget.
	 */
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
 * itself, wayfind, the plan coordinator) calls this — never `new
 * PowerToolStatusWidget()` directly, or it will get its own disconnected
 * widget instance.
 *
 * NOTE: deliberately NOT an `instanceof PowerToolStatusWidget` guard. Since
 * pi loads extensions via jiti, a jiti-loaded copy of this module and a
 * natively-imported copy can produce DIFFERENT class identities for
 * `PowerToolStatusWidget` even though they're "the same" class — `instanceof`
 * would then return false for whichever loader didn't create the instance,
 * causing that caller to overwrite the global slot with its own instance and
 * defeating the whole point of this function. Instead we trust whatever
 * object already occupies the global slot (first writer wins) and only
 * construct a new one when the slot is empty.
 */
export function getSharedStatusWidget(): PowerToolStatusWidget {
	const g = globalThis as Record<string, unknown>;
	if (!g[SINGLETON_GLOBAL_KEY]) {
		g[SINGLETON_GLOBAL_KEY] = new PowerToolStatusWidget();
	}
	return g[SINGLETON_GLOBAL_KEY] as PowerToolStatusWidget;
}
