/**
 * dock-claim.ts — Task 08 PART 2 (A2 wiring adapter; ADR-core-task-0001).
 *
 * The onTerminalInput ADAPTER around the pure dock state machine (dock.ts,
 * PART 1): owns the Ctrl-G `s` prefix-claim entry and the consume-until-Esc
 * release, and routes the machine's actions to the real seams (registry abort,
 * shared ctrl+b dispatch, /subagents viewer). No pi imports, no terminal — the
 * handler seam is the same string-in / `{consume}` | undefined-out shape
 * `ctx.ui.onTerminalInput` expects, so the whole claim is table-testable.
 *
 * Entry semantics:
 * - Ctrl-G (`\x07`) claims its own byte and arms a short entry window
 *   (default 600ms); re-arming restarts the window (a stale expiry is inert).
 * - `s` inside the window enters focus ONLY when the subagents section has
 *   background runs (runs-gated); with no runs (or an expired window) the `s`
 *   passes through to the editor untouched.
 * - Any other follow-up key disarms the prefix and passes through.
 *
 * Focus semantics:
 * - While focused every key chunk is consumed entirely; each byte routes
 *   through `createDockFocus` (one machine instance for the claim's lifetime —
 *   selection is sticky across focus sessions, re-clamped live).
 * - Esc / Enter (open-viewer) release the claim; release also drops the render
 *   state (onDockState(undefined)) so the section repaints plain immediately.
 * - `expanded` is a render flag (not machine state): reset on release, never
 *   carried into the next focus session.
 */
import type { RunView } from "@repo/pi-agent-ext-core-runtime";
import { createDockFocus } from "./dock.js";
import type { DockRenderState } from "./dock.js";

/** Ctrl-G — the dock focus prefix byte. */
const CTRL_G = "\x07";
/** The follow-up key that completes the entry while the window is live. */
const ENTRY_KEY = "s";
/** Default entry window (ms) for the Ctrl-G → `s` prefix pair. */
const DEFAULT_ENTRY_WINDOW_MS = 600;

const CONSUME = { consume: true } as const;

export interface DockFocusClaimDeps {
	/** prod: () => registry.views({ foreground: false }) — the dockable list. */
	getViews: () => RunView[];
	/** abort-confirm (`y` after `x`): fire the selected run's abort lever. */
	abort: (id: string) => void;
	/** background (ctrl+b): the shared detach dispatch seam (dispatchCtrlB). */
	background: () => void;
	/** open-viewer (Enter): mount /subagents on the selected run. */
	openViewer: (id: string) => void;
	/** Render-state fanout: focused state while docked, `undefined` on release. */
	onDockState: (state: DockRenderState | undefined) => void;
	/** Injectable for tests (default: global setTimeout/clearTimeout). */
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
	/** Entry window for the Ctrl-G → `s` prefix pair (default 600ms). */
	entryWindowMs?: number;
}

export interface DockFocusClaim {
	/** onTerminalInput seam: string in, `{consume}` | undefined out. */
	handleInput(data: string): { consume: boolean } | undefined;
	isFocused(): boolean;
	/** Programmatic release (host teardown) — same effects as Esc. */
	release(): void;
}

export function createDockFocusClaim(deps: DockFocusClaimDeps): DockFocusClaim {
	const windowMs = deps.entryWindowMs ?? DEFAULT_ENTRY_WINDOW_MS;
	const so = deps.setTimeout ?? setTimeout;
	// The seam types the timers as `unknown` so tests can inject fake handles
	// (dock-claim.test.ts injects a number-returning setTimeout). The global
	// clearTimeout is strictly typed (string | number | Timer), so union-ing it
	// with the seam's `(handle: unknown) => void` makes `ct(windowHandle)` fail
	// to typecheck when the handle is unknown. Wrap the default to the seam's
	// signature instead — the cast is a type-level shim: the handle is whatever
	// the real setTimeout produced, which clearTimeout accepts at runtime.
	const ct = deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
	const focus = createDockFocus(() => deps.getViews().length);
	let focused = false;
	let prefixArmed = false;
	let expanded = false;
	let windowHandle: unknown;
	let windowGen = 0;

	const clearWindow = () => {
		if (windowHandle !== undefined) {
			ct(windowHandle);
			windowHandle = undefined;
		}
	};
	const disarmPrefix = () => {
		prefixArmed = false;
		clearWindow();
	};
	const armWindow = () => {
		windowGen += 1;
		const myGen = windowGen;
		const handle = so(() => {
			if (myGen !== windowGen) return; // superseded window — inert
			windowHandle = undefined;
			prefixArmed = false; // window elapsed before the `s` arrived
		}, windowMs);
		// Schedule the fresh window BEFORE cancelling the superseded one: the
		// gen guard already makes a stale expiry inert either way, and exactly
		// one window stays live through a re-arm (JS is single-threaded, so the
		// interim double-window can never fire mid-schedule).
		if (windowHandle !== undefined) ct(windowHandle);
		windowHandle = handle;
	};
	const emit = () => deps.onDockState({ selected: focus.selected, armed: focus.isArmed(), expanded });

	const releaseClaim = () => {
		focused = false;
		expanded = false; // never carried into the next focus session
		focus.reset(); // sessions end unarmed (a live arm does not survive)
		disarmPrefix();
		deps.onDockState(undefined); // section repaints plain immediately
	};

	const selectedId = (): string | undefined => {
		const views = deps.getViews();
		const idx = Math.min(focus.selected, views.length - 1);
		return idx >= 0 ? views[idx]?.id : undefined;
	};

	const routeFocusedKey = (key: string): void => {
		switch (focus.handleKey(key).kind) {
			case "abort-confirm": {
				const id = selectedId();
				if (id !== undefined) deps.abort(id);
				emit();
				return;
			}
			case "abort-arm":
			case "abort-cancel":
			case "scroll":
				emit();
				return;
			case "expand":
				expanded = !expanded;
				emit();
				return;
			case "background":
				deps.background();
				emit(); // the machine disarms on \x02 — repaint the header marker
				return;
			case "open-viewer": {
				const id = selectedId();
				releaseClaim(); // the viewer owns input now — no double routing
				if (id !== undefined) deps.openViewer(id);
				return;
			}
			case "release":
				releaseClaim();
				return;
			case "noop":
				return; // consumed-but-ignored: no state change, no emit
		}
	};

	const enterFocus = () => {
		focused = true;
		expanded = false;
		focus.reset(); // sessions start unarmed (sticky selection survives)
		emit();
	};

	return {
		handleInput: (data: string) => {
			if (focused) {
				for (const key of data) routeFocusedKey(key);
				return { consume: true };
			}
			if (data === CTRL_G) {
				prefixArmed = true;
				armWindow(); // re-arming restarts the window
				return { consume: true };
			}
			if (!prefixArmed) return undefined;
			if (data !== ENTRY_KEY) {
				disarmPrefix(); // the follow-up key passes through to the editor
				return undefined;
			}
			disarmPrefix(); // the window served its purpose
			if (deps.getViews().length === 0) return undefined; // runs-gated: `s` reaches the editor
			enterFocus();
			return { consume: true };
		},
		isFocused: () => focused,
		release: releaseClaim,
	};
}
