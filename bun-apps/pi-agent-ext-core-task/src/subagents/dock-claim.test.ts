/**
 * dock-claim.test.ts — Task 08 PART 2 (A2 wiring, ticket 08 of the CC-style
 * subagent TUI plan; ADR-core-task-0001).
 *
 * Covers the onTerminalInput ADAPTER around the pure dock state machine
 * (dock.ts, landed in A1): the Ctrl-G `s` prefix-claim entry (window-gated,
 * runs-gated), Esc release with no post-release key leak, per-action dep
 * routing while focused, and full pass-through for non-claimed keys.
 *
 * No pi imports, no terminal — the handler seam is the same string-in /
 * {consume} | undefined-out shape ctx.ui.onTerminalInput expects.
 */
import { describe, expect, test } from "bun:test";
import type { RunView } from "@repo/pi-agent-ext-core-runtime";
import { createDockFocusClaim } from "./dock-claim.ts";
import type { DockRenderState } from "./dock.ts";

const fakeView = (id: string): RunView =>
	({
		id,
		foreground: false,
		status: "running",
		actor: "researcher",
		modelSeg: "sonnet",
		elapsedMs: 1000,
		elapsedFrozen: false,
		toolCallCount: 0,
		taskPreview: `task ${id}`,
		latestAction: undefined,
		abortable: true,
		history: [],
		startedAt: 0,
		costUsd: 0,
		tokensIn: 0,
		tokensOut: 0,
	}) as RunView;

interface Harness {
	claim: ReturnType<typeof createDockFocusClaim>;
	aborted: string[];
	/** Getter — a plain `backgrounds,` shorthand would snapshot 0 at harness
	 * creation (numbers copy; the array fields above mutate by reference). */
	readonly backgrounds: number;
	viewer: (string | undefined)[];
	states: (DockRenderState | undefined)[];
	fakeTick: (fn: () => void) => number;
	fireWindow: () => void;
}

/** Fake setTimeout/clearTimeout pair: exactly one live window timer. */
function makeHarness(views: RunView[]): Harness {
	const aborted: string[] = [];
	let backgrounds = 0;
	const viewer: (string | undefined)[] = [];
	const states: (DockRenderState | undefined)[] = [];
	let pending: (() => void) | undefined;
	const claim = createDockFocusClaim({
		getViews: () => views,
		abort: (id) => aborted.push(id),
		background: () => {
			backgrounds++;
		},
		openViewer: (id) => viewer.push(id),
		onDockState: (s) => states.push(s),
		setTimeout: (fn) => {
			pending = fn;
			return 0;
		},
		clearTimeout: () => {
			pending = undefined;
		},
		entryWindowMs: 600,
	});
	return {
		claim,
		aborted,
		get backgrounds() {
			return backgrounds;
		},
		viewer,
		states,
		fakeTick: () => {
			throw new Error("unused");
		},
		fireWindow: () => {
			const fn = pending;
			pending = undefined;
			fn?.();
		},
	};
}

describe("dock claim — Ctrl-G s prefix entry", () => {
	test("Ctrl-G then s enters focus when runs exist; j is consumed and routed", () => {
		const h = makeHarness([fakeView("a"), fakeView("b")]);
		expect(h.claim.handleInput("\x07")).toEqual({ consume: true }); // Ctrl-G claimed
		expect(h.claim.handleInput("s")).toEqual({ consume: true }); // s completes the entry
		expect(h.claim.isFocused()).toBe(true);
		expect(h.states.at(-1)).toEqual({ selected: 0, armed: false, expanded: false });
		expect(h.claim.handleInput("j")).toEqual({ consume: true });
		expect(h.states.at(-1)).toEqual({ selected: 1, armed: false, expanded: false });
	});

	test("Ctrl-G then a non-s key: the follow-up key passes through and the prefix disarms", () => {
		const h = makeHarness([fakeView("a")]);
		h.claim.handleInput("\x07");
		expect(h.claim.handleInput("x")).toBeUndefined(); // editor keeps it
		expect(h.claim.isFocused()).toBe(false);
		// disarmed: a later bare `s` is NOT an entry
		expect(h.claim.handleInput("s")).toBeUndefined();
	});

	test("s without Ctrl-G passes through unconsumed", () => {
		const h = makeHarness([fakeView("a")]);
		expect(h.claim.handleInput("s")).toBeUndefined();
		expect(h.claim.isFocused()).toBe(false);
	});

	test("entry refused when the section has no runs; s reaches the editor", () => {
		const h = makeHarness([]);
		h.claim.handleInput("\x07");
		expect(h.claim.handleInput("s")).toBeUndefined();
		expect(h.claim.isFocused()).toBe(false);
	});

	test("entry window expiry disarms the prefix (late s passes through)", () => {
		const h = makeHarness([fakeView("a")]);
		h.claim.handleInput("\x07");
		h.fireWindow(); // window elapsed before the `s` arrived
		expect(h.claim.handleInput("s")).toBeUndefined();
		expect(h.claim.isFocused()).toBe(false);
	});

	test("re-arming Ctrl-G restarts the window (old window cancelled)", () => {
		const h = makeHarness([fakeView("a")]);
		h.claim.handleInput("\x07");
		h.claim.handleInput("\x07"); // re-arm within the window
		h.fireWindow(); // first window's callback fires — the second must supersede
		// if the re-arm restarted the window this s still completes the entry
		expect(h.claim.handleInput("s")).toEqual({ consume: true });
		expect(h.claim.isFocused()).toBe(true);
	});
});

describe("dock claim — focused key routing", () => {
	const enter = (h: Harness) => {
		h.claim.handleInput("\x07");
		h.claim.handleInput("s");
	};

	test("x arms (armed state), y aborts the SELECTED run id", () => {
		const h = makeHarness([fakeView("a"), fakeView("b")]);
		enter(h);
		h.claim.handleInput("j"); // select index 1
		h.claim.handleInput("x");
		expect(h.states.at(-1)).toEqual({ selected: 1, armed: true, expanded: false });
		expect(h.aborted).toEqual([]); // armed only — nothing fired yet
		h.claim.handleInput("y");
		expect(h.aborted).toEqual(["b"]);
		expect(h.states.at(-1)?.armed).toBe(false);
	});

	test("x without y never aborts; n cancels", () => {
		const h = makeHarness([fakeView("a")]);
		enter(h);
		h.claim.handleInput("x");
		h.claim.handleInput("n");
		expect(h.aborted).toEqual([]);
		expect(h.states.at(-1)?.armed).toBe(false);
		h.claim.handleInput("y"); // y without a live arm is a noop
		expect(h.aborted).toEqual([]);
	});

	test("e toggles the expanded render state", () => {
		const h = makeHarness([fakeView("a")]);
		enter(h);
		h.claim.handleInput("e");
		expect(h.states.at(-1)?.expanded).toBe(true);
		h.claim.handleInput("e");
		expect(h.states.at(-1)?.expanded).toBe(false);
	});

	test("ctrl+b (\\x02) routes to the shared background dispatch seam", () => {
		const h = makeHarness([fakeView("a")]);
		enter(h);
		expect(h.claim.handleInput("\x02")).toEqual({ consume: true });
		expect(h.backgrounds).toBe(1);
	});

	test("Enter (\\r) opens the viewer on the selected id AND releases the claim", () => {
		const h = makeHarness([fakeView("a"), fakeView("b")]);
		enter(h);
		h.claim.handleInput("j");
		expect(h.claim.handleInput("\r")).toEqual({ consume: true });
		expect(h.viewer).toEqual(["b"]);
		expect(h.claim.isFocused()).toBe(false); // viewer owns input now — no double routing
		expect(h.claim.handleInput("j")).toBeUndefined(); // next key reaches the editor
		expect(h.states.at(-1)).toBeUndefined(); // dock state cleared
	});

	test("unknown keys while focused are consumed-but-ignored", () => {
		const h = makeHarness([fakeView("a")]);
		enter(h);
		const before = h.states.length;
		expect(h.claim.handleInput("z")).toEqual({ consume: true });
		expect(h.states.length).toBe(before); // no state change
		expect(h.claim.isFocused()).toBe(true);
	});

	test("multi-char chunk while focused is consumed entirely", () => {
		const h = makeHarness([fakeView("a"), fakeView("b")]);
		enter(h);
		expect(h.claim.handleInput("hj")).toEqual({ consume: true }); // h noop, j scroll
		expect(h.states.at(-1)?.selected).toBe(1);
	});

	test("Esc consumes THIS key and releases; the next key is not consumed (no leak)", () => {
		const h = makeHarness([fakeView("a")]);
		enter(h);
		expect(h.claim.handleInput("\x1b")).toEqual({ consume: true });
		expect(h.claim.isFocused()).toBe(false);
		expect(h.claim.handleInput("j")).toBeUndefined();
		expect(h.states.at(-1)).toBeUndefined();
	});

	test("release() drops the claim programmatically and clears dock state", () => {
		const h = makeHarness([fakeView("a")]);
		enter(h);
		h.claim.release();
		expect(h.claim.isFocused()).toBe(false);
		expect(h.states.at(-1)).toBeUndefined();
		expect(h.claim.handleInput("j")).toBeUndefined();
	});

	test("expanded flag resets on release, not carried into the next focus", () => {
		const h = makeHarness([fakeView("a")]);
		enter(h);
		h.claim.handleInput("e"); // expand
		h.claim.handleInput("\x1b"); // release
		enter(h);
		expect(h.states.at(-1)).toEqual({ selected: 0, armed: false, expanded: false });
	});

	test("selection persists across focus sessions (sticky, clamped live)", () => {
		const h = makeHarness([fakeView("a"), fakeView("b")]);
		enter(h);
		h.claim.handleInput("j"); // select 1
		h.claim.handleInput("\x1b");
		enter(h);
		expect(h.states.at(-1)?.selected).toBe(1);
	});
});

describe("dock claim — non-focused pass-through", () => {
	test("ordinary typing is never consumed while passive", () => {
		const h = makeHarness([fakeView("a")]);
		for (const k of ["a", "j", "x", "\r", "\x02"]) {
			expect(h.claim.handleInput(k)).toBeUndefined();
		}
		expect(h.claim.isFocused()).toBe(false);
		expect(h.aborted).toEqual([]);
		expect(h.backgrounds).toBe(0);
		expect(h.viewer).toEqual([]);
		expect(h.states).toEqual([]);
	});
});
