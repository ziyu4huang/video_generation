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
 * Collapsed when idle: zero background runs and no notifyLine → `[]` (the
 * composite widget hides empty sections). A 1s refresh timer re-requests a
 * render only while runs are live, so live elapsed ticks without idle churn
 * (mirrors subagent-context-widget.ts P5).
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderRunRow } from "@repo/pi-agent-ext-core-runtime";
import type { RunView } from "@repo/pi-agent-ext-core-runtime";
import type { StatusSection } from "../shared/status-widget.js";

const REFRESH_MS = 1000;

export interface SubagentsSectionDeps {
	/** prod: () => registry.views({ foreground: false }) */
	getViews: () => RunView[];
	/** prod: () => getSharedStatusWidget().update() */
	requestRender: () => void;
	/** Injectable for tests (default: global setInterval). */
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
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
			if (views.length === 0 && !notifyLine) return [];
			const lines: string[] = [];
			if (notifyLine) lines.push(notifyLine);
			if (views.length > 0) {
				lines.push(` ${views.length} background ${views.length === 1 ? "run" : "runs"}`);
				for (const v of views) lines.push(`  ${renderRunRow(v, theme)}`);
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
