/**
 * The theming half of the error/cancel renderer.
 *
 * `render-search-error.ts` builds the PLAN (plain strings, no theme, no
 * components) and states in its own header that it stays dependency-free so it
 * can be unit-tested without pi's runtime. This module is the other half: it
 * turns a plan into pi-tui components. Keeping them in separate files preserves
 * that boundary — the plan's tests never load pi-tui, and this file has nothing
 * worth testing beyond the wiring.
 *
 * It lives here rather than in index.ts because all three tools' renderResult
 * error branches call it (web_search, fetch_content, get_search_content), and
 * two of those now live in their own modules. A shared helper reachable only
 * from inside index.ts's `export default function (pi)` closure would have had
 * to be re-exported from index.ts, making every extracted tool import its own
 * parent.
 */

import { Box, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SearchErrorPlan } from "./render-search-error.ts";

/**
 * Shared collapsed/expanded renderer for a plan produced by
 * buildSearchErrorPlan(). Used by every tool's renderResult error branch so
 * Ctrl+O (app.tools.expand) reveals diagnostics instead of a dead-end line.
 *
 * `theme` is pi's real `Theme`, not the structural `{ fg, bg }` this was
 * originally annotated with. That hand-written shape is what made all three
 * call sites error under the checker (TS2345: 'Theme' is not assignable) —
 * Theme's `fg`/`bg` take a `ThemeColor`, not an arbitrary `string` key.
 */
export function renderSearchErrorPlan(plan: SearchErrorPlan, expanded: boolean, theme: Theme) {
	if (expanded) {
		return new Text(
			plan.expanded.map((l, i) => (i === 0 ? theme.fg("error", l) : theme.fg("toolOutput", l))).join("\n"),
			0,
			0,
		);
	}
	const box = new Box(1, 0, (t) => theme.bg("toolErrorBg", t));
	box.addChild(new Text(theme.fg("error", plan.expanded[0] ?? ""), 0, 0));
	for (const line of plan.collapsed) {
		box.addChild(new Text(theme.fg("dim", line), 0, 0));
	}
	if (plan.expandHint) {
		box.addChild(new Text(theme.fg("muted", plan.expandHint), 0, 0));
	}
	return box;
}
