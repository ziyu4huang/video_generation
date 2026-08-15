/**
 * dock.ts — pure dock focus state machine (Task 08 PART 1; ADR-core-task-0001).
 *
 * PART 1 of 2 — PURE LOGIC ONLY: no pi imports, no I/O, no theme. This module
 * owns the dock keymap table (the ADR-core-task-0001 table, verbatim) and the
 * selection + abort-arm state machine. The onTerminalInput prefix-claim
 * wiring (Ctrl-G `s` entry, consume-until-Esc release) lands in PART A2
 * against this surface:
 *
 *   const focus = createDockFocus(() => registry.views({ foreground: false }).length);
 *   const action = focus.handleKey(rawByte); // → dispatch in the A2 adapter
 *
 * Semantics:
 * - DOCK_KEYMAP maps raw key bytes to actions; the table values ARE the
 *   canonical action objects — handleKey returns them by reference, so treat
 *   the table as frozen (do not mutate returned actions).
 * - selected index lives in [0, runCount()-1]; scroll clamps at both bounds
 *   (the action still reports {kind:"scroll"} — intent, not movement — so the
 *   A2 layer can repaint the hint line even when selection is pinned).
 * - abort arm is one-shot: `x` arms (re-arming keeps the flag set); the NEXT
 *   `y` (confirm) or `n` (cancel) resolves it and clears the flag; `y`/`n`
 *   without a live arm are noop; every other key disarms.
 * - runCount() === 0: every run-targeted action is noop (nothing selected to
 *   scroll/abort/expand/detach/jump) and arming is impossible — Esc still
 *   returns release so the A2 claim holder can always drop the claim.
 */
export type DockAction =
	| { kind: "scroll"; delta: 1 | -1 }
	| { kind: "abort-arm" }
	| { kind: "abort-confirm" }
	| { kind: "abort-cancel" }
	| { kind: "expand" }
	| { kind: "background" }
	| { kind: "open-viewer" }
	| { kind: "release" }
	| { kind: "noop" };

export const DOCK_KEYMAP: Record<string, DockAction> = {
	j: { kind: "scroll", delta: 1 }, // selection down
	k: { kind: "scroll", delta: -1 }, // selection up
	x: { kind: "abort-arm" }, // abort selected run → y fires / n cancels
	y: { kind: "abort-confirm" },
	n: { kind: "abort-cancel" },
	e: { kind: "expand" }, // expand trace overlay
	"\x02": { kind: "background" }, // ctrl+b — detach selected run
	"\r": { kind: "open-viewer" }, // Enter — jump to /subagents viewer
	"\x1b": { kind: "release" }, // Esc — release the focus claim
};

const NOOP: DockAction = { kind: "noop" };

export interface DockFocus {
	/** Resolve one raw key byte to its action, advancing selection/arm state. */
	handleKey(key: string): DockAction;
	/** True while an armed abort awaits y/n. */
	isArmed(): boolean;
	/** Selected run index, re-clamped to the current run list on every read. */
	readonly selected: number;
}

export function createDockFocus(runCount: () => number): DockFocus {
	let index = 0;
	let armed = false;
	const handleKey = (key: string): DockAction => {
		const action = DOCK_KEYMAP[key];
		const n = runCount();
		if (n === 0) {
			armed = false; // nothing left to abort; the claim stays releasable
			return action?.kind === "release" ? action : NOOP;
		}
		if (action === undefined) {
			armed = false;
			return NOOP;
		}
		switch (action.kind) {
			case "scroll":
				armed = false;
				index = Math.min(Math.max(index + action.delta, 0), n - 1);
				return action;
			case "abort-arm":
				armed = true; // x x y aborts once — re-arm keeps the flag set
				return action;
			case "abort-confirm":
			case "abort-cancel":
				if (!armed) return NOOP; // one-shot: resolvers need a live arm
				armed = false;
				return action;
			default: // expand / background / open-viewer / release disarm
				armed = false;
				return action;
		}
	};
	return {
		handleKey,
		isArmed: () => armed,
		get selected() {
			const n = runCount();
			return n === 0 ? 0 : Math.min(index, n - 1);
		},
	};
}
