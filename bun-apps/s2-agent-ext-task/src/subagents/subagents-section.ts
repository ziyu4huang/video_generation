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
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderRunRow } from "@repo/s2-agent-core-runtime";
import type { RunView } from "@repo/s2-agent-core-runtime";
import {
	capTraceTail,
	currentTerminalRows,
	formatSubagentTrace,
	latestMessageLine,
	viewportTraceTail,
} from "@repo/s2-agent-core-runtime";
import type { StatusSection } from "../shared/status-widget.js";
import type { DockRenderState } from "./dock.js";
import { SubagentNotify } from "./notify.js";

const REFRESH_MS = 1000;

/** One-line keymap cheat-sheet rendered on top while dock focus is held
 * (ticket 08). Single source — the section and any diagnostics share it. */
export const DOCK_HINT_LINE =
	" ⎇ dock focused · j/k scroll · x abort · e trace · ctrl+b detach · ⏎ viewer · esc release";

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
	/** Task 08 PART 2: dock focus render state (hint line, ▶ selection, armed
	 * marker, expanded trace). `undefined` restores plain rendering. Requests a
	 * render on every call so repaints don't wait for the 1s tick. */
	setDockState: (state: DockRenderState | undefined) => void;
	/** Stops the refresh timer. */
	dispose: () => void;
}

export function createSubagentsSection(deps: SubagentsSectionDeps): SubagentsSectionHandle {
	let notifyLine: string | undefined;
	let dockState: DockRenderState | undefined;
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
		render: (theme: Theme, width: number): string[] => {
			const views = deps.getViews();
			// Task 02: diff consecutive snapshots; a stamped line shows THIS tick only.
			notify.diff(prevViews, views);
			prevViews = views;
			const [transient] = notify.take();
			if (views.length === 0 && !notifyLine && !transient && !dockState) return [];
			// Ticket 04: consume the previously-discarded render width — a
			// section-level whole-line guard fits every composed header/row/quote/
			// trace line to the terminal width (CJK + ANSI correct via pi-tui;
			// truncateToWidth returns its input unchanged when it already fits,
			// and the visibleWidth fast path keeps short lines byte-identical).
			// The core-runtime row helpers stay untouched — their char-count caps
			// still bound content BEFORE this guard trims any remainder. The dock
			// hint line is explicitly exempt (DOCK_HINT_LINE renders as-is).
			const fit = (line: string): string =>
				visibleWidth(line) <= width ? line : truncateToWidth(line, width);
			const lines: string[] = [];
			if (dockState) lines.push(DOCK_HINT_LINE);
			if (transient) lines.push(` ${transient}`);
			if (notifyLine) lines.push(notifyLine);
			if (views.length > 0) {
				let header = ` ${views.length} background ${views.length === 1 ? "run" : "runs"}`;
				if (dockState?.armed) header = `${header} · [abort? y/n]`;
				lines.push(fit(header));
				views.forEach((v, i) => {
					const selected = dockState !== undefined && dockState.selected === i;
					const row = fit(`${selected ? "▶" : " "} ${renderRunRow(v, theme)}`);
					if (selected && dockState?.expanded) {
						// Task 08: expanded — the selected run renders as ONE capped block,
						// [row, ...trace] through capTraceTail, so a long trace keeps a
						// viewport-safe tail and the row scrolls inside that window. The
						// ↳ latest line is subsumed by the trace. tui-cc-parity-2 ticket
						// 01: the cap is a FUNCTION of terminal height (viewportTraceTail)
						// — the same #1104 rule (box must fit the viewport, stable between
						// resizes) with CC's fill-the-viewport sizing on tall terminals.
						const trace = formatSubagentTrace(v.history, v.elapsedMs, v.toolCallCount);
						const block = capTraceTail(
							trace === "" ? [row] : [row, ...trace.split("\n")],
							viewportTraceTail(currentTerminalRows()),
						);
						const rowVisible = block[0] === row; // uncapped: the row stays in view
						block.forEach((l, bi) => {
							if (bi === 0 && rowVisible) lines.push(l); // row: already fitted above
							else lines.push(fit(`      ${l}`)); // trace: fit after the 6-space indent
						});
						return;
					}
					lines.push(row);
					// Task 04: migrated from the retired subagent-context-widget's
					// collapsed view — one latest activity/prose line beneath each row
					// (prose renders quoted; see latestMessageLine).
					// Ticket 04: thread width into the ticket-01 helper (the quote line
					// renders 4-space indented, so it gets width - 4), then guard the
					// indented line as backstop for any cap/wide-char remainder.
					const live = latestMessageLine(v.history, Math.max(1, width - 4));
					if (live) lines.push(fit(`    ${live}`));
				});
			}
			return lines;
		},
	};
	timer = si(tick, REFRESH_MS);
	// Unref only the DEFAULT (real) interval — a live background-run section
	// must never keep a headless process alive (mirrors goal's status/heartbeat
	// timers and the wakeup loop's timer). Injected test timers pass through
	// untouched.
	if (!deps.setInterval) (timer as { unref?: () => void }).unref?.();
	return {
		section,
		setNotifyLine: (l) => {
			notifyLine = l;
			deps.requestRender();
		},
		setDockState: (state) => {
			dockState = state;
			deps.requestRender(); // hint/selection repaint without waiting for the tick
		},
		dispose: () => {
			if (timer !== undefined) ci(timer);
		},
	};
}
