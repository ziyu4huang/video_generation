/**
 * subagents-section.ts — the order-4 `subagents` section of the composite
 * CoreTaskStatusWidget (Task 01, CC-style subagent TUI plan).
 *
 * Renders ONLY background runs — `registry.views({ foreground: false })` —
 * so a run never appears on both surfaces (foreground runs render inline via
 * the tool's own call/result line, Surface A; exclusion rule, REVIEW §4).
 *
 * Row rendering uses `renderRunRow` from core-runtime (the RunView-typed row
 * renderer in agent-row-display.ts; `renderActivityRow` is its ActivityRow
 * cousin and would silently drop modelSeg/toolCallCount for a RunView).
 *
 * Collapsed when idle: zero background runs and no notify/transient line → `[]`
 * (the composite widget hides empty sections). A 1s refresh timer re-requests a
 * render only while runs are live, so live elapsed ticks without idle churn
 * (mirrors subagent-context-widget.ts P5).
 *
 * Task 02: a SubagentNotify diffs consecutive per-tick view snapshots inside
 * render(); a completion (non-terminal → terminal) stamps a transient line at
 * the top of the section for THIS tick only — render reads notify.take() fresh
 * each call, never cached across ticks (RunView contract).
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderRunRow } from "@repo/pi-agent-ext-core-runtime";
import type { RunView } from "@repo/pi-agent-ext-core-runtime";
import { latestMessageLine } from "@repo/pi-agent-ext-subagent";
import type { StatusSection } from "../shared/status-widget.js";
import { SubagentNotify } from "./notify.js";

const REFRESH_MS = 1000;

export interface SubagentsSectionDeps {
	/** prod: () => registry.views({ foreground: false }) */
	getViews: () => RunView[];
	/** prod: () => getSharedStatusWidget().update() */
	requestRender: () => void;
	/** Injectable for tests (default: global setInterval). */
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
	/** Injectable for tests (default: SubagentNotify's stdout bell). */
	bell?: () => void;
}

export interface SubagentsSectionHandle {
	section: StatusSection; // { id: "subagents", order: 4 }
	/** Task 02 consumes: transient completion-notify line rendered on top. */
	setNotifyLine: (line: string | undefined) => void;
	/** Stops the refresh timer. */
	dispose: () => void;
}

export function createSubagentsSection(deps: SubagentsSectionDeps): SubagentsSectionHandle {
	let notifyLine: string | undefined;
	const notify = new SubagentNotify({ bell: deps.bell });
	let prevViews: RunView[] = [];
	const si = deps.setInterval ?? setInterval;
	const ci = deps.clearInterval ?? clearInterval;
	let timer: ReturnType<typeof setInterval> | undefined;
	const tick = () => {
		if (deps.getViews().length > 0) deps.requestRender();
	};
	const section: StatusSection = {
		id: "subagents",
		order: 4, // contract: goal=0, todo=1, wayfind=2, coordinator=3, subagents=4
		render: (theme: Theme, _width: number): string[] => {
			const views = deps.getViews();
			// Task 02: diff consecutive snapshots; a stamped line shows THIS tick only.
			notify.diff(prevViews, views);
			prevViews = views;
			const [transient] = notify.take();
			if (views.length === 0 && !notifyLine && !transient) return [];
			const lines: string[] = [];
			if (transient) lines.push(` ${transient}`);
			if (notifyLine) lines.push(notifyLine);
			if (views.length > 0) {
				lines.push(` ${views.length} background ${views.length === 1 ? "run" : "runs"}`);
				for (const v of views) {
					lines.push(`  ${renderRunRow(v, theme)}`);
					// Task 04: migrated from the retired subagent-context-widget's
					// collapsed view — one latest activity/prose line beneath each row
					// (prose renders quoted; see latestMessageLine).
					const live = latestMessageLine(v.history);
					if (live) lines.push(`    ${live}`);
				}
			}
			return lines;
		},
	};
	timer = si(tick, REFRESH_MS);
	return {
		section,
		setNotifyLine: (l) => {
			notifyLine = l;
			deps.requestRender();
		},
		dispose: () => {
			if (timer !== undefined) ci(timer);
		},
	};
}
