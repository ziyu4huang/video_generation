/**
 * dock.test.ts — pure dock focus state machine (Task 08 PART 1; ADR-task-0001).
 *
 * Table-driven coverage over DOCK_KEYMAP plus the state-machine specifics:
 * clamp bounds at 0 and runCount-1, one-shot arm/confirm/cancel flow,
 * empty-runs noop, disarm-on-any-non-resolver key.
 *
 * PART 1 is pure logic — no pi imports, no terminal, no theme. The
 * onTerminalInput prefix-claim wiring (Ctrl-G `s` entry, Esc release of the
 * claim) is Task 08 PART A2 and is NOT under test here.
 */
import { describe, expect, test } from "bun:test";
import { createDockFocus, DOCK_KEYMAP } from "./dock.ts";
import type { DockAction } from "./dock.ts";

const noop = (): DockAction => ({ kind: "noop" });

describe("DOCK_KEYMAP", () => {
	test("matches the ADR-task-0001 table exactly", () => {
		expect(DOCK_KEYMAP).toEqual({
			j: { kind: "scroll", delta: 1 },
			k: { kind: "scroll", delta: -1 },
			x: { kind: "abort-arm" },
			y: { kind: "abort-confirm" },
			n: { kind: "abort-cancel" },
			e: { kind: "expand" },
			"\x02": { kind: "background" }, // ctrl+b
			"\r": { kind: "open-viewer" }, // Enter
			"\x1b": { kind: "release" }, // Esc
		});
	});

	test("every entry routes to its action (table-driven)", () => {
		for (const [key, action] of Object.entries(DOCK_KEYMAP)) {
			switch (action.kind) {
				case "scroll": {
					const d = createDockFocus(() => 3);
					expect(d.handleKey(key)).toEqual(action);
					expect(d.selected).toBe(action.delta === 1 ? 1 : 0); // -1 clamps low
					break;
				}
				case "abort-arm": {
					const d = createDockFocus(() => 3);
					expect(d.handleKey(key)).toEqual(action);
					expect(d.isArmed()).toBe(true);
					break;
				}
				case "abort-confirm":
				case "abort-cancel": {
					const d = createDockFocus(() => 3);
					d.handleKey("x"); // arm first — resolvers need a live arm
					expect(d.handleKey(key)).toEqual(action);
					expect(d.isArmed()).toBe(false);
					break;
				}
				default: {
					const d = createDockFocus(() => 3);
					expect(d.handleKey(key)).toEqual(action);
					break;
				}
			}
		}
	});
});

describe("createDockFocus", () => {
	test("scroll clamps to [0, runCount-1] at both bounds", () => {
		let runs = 3;
		const d = createDockFocus(() => runs);
		expect(d.handleKey("k")).toEqual({ kind: "scroll", delta: -1 });
		expect(d.selected).toBe(0); // clamped low
		for (let i = 0; i < 10; i++) d.handleKey("j");
		expect(d.selected).toBe(2); // clamped high
		runs = 1; // run list shrinks mid-flight
		expect(d.selected).toBe(0);
	});

	test("abort flow: x arms (re-arm keeps armed), y fires exactly once", () => {
		const d = createDockFocus(() => 2);
		expect(d.isArmed()).toBe(false);
		expect(d.handleKey("x")).toEqual({ kind: "abort-arm" });
		expect(d.isArmed()).toBe(true);
		expect(d.handleKey("x")).toEqual({ kind: "abort-arm" }); // re-arm stays armed
		expect(d.isArmed()).toBe(true);
		expect(d.handleKey("y")).toEqual({ kind: "abort-confirm" });
		expect(d.isArmed()).toBe(false);
		expect(d.handleKey("y")).toEqual(noop()); // one-shot: second y is a no-op
		expect(d.isArmed()).toBe(false);
	});

	test("abort cancel: x arms, n cancels, y after n is a no-op", () => {
		const d = createDockFocus(() => 2);
		expect(d.handleKey("x")).toEqual({ kind: "abort-arm" });
		expect(d.handleKey("n")).toEqual({ kind: "abort-cancel" });
		expect(d.isArmed()).toBe(false);
		expect(d.handleKey("y")).toEqual(noop());
	});

	test("y/n without arming are no-ops", () => {
		const d = createDockFocus(() => 2);
		expect(d.handleKey("y")).toEqual(noop());
		expect(d.handleKey("n")).toEqual(noop());
		expect(d.isArmed()).toBe(false);
	});

	test("any non-resolver key disarms an armed abort (table-driven)", () => {
		for (const key of Object.keys(DOCK_KEYMAP)) {
			if (key === "x" || key === "y" || key === "n") continue; // x re-arms; y/n resolve
			const d = createDockFocus(() => 2);
			d.handleKey("x");
			expect(d.isArmed()).toBe(true);
			d.handleKey(key);
			expect(d.isArmed(), `key ${JSON.stringify(key)} must disarm`).toBe(false);
		}
		const d2 = createDockFocus(() => 2);
		d2.handleKey("x");
		expect(d2.handleKey("z")).toEqual(noop()); // unknown key disarms too
		expect(d2.isArmed()).toBe(false);
	});

	test("empty runs: run-targeted keys are noop; Esc still releases", () => {
		const d = createDockFocus(() => 0);
		expect(d.selected).toBe(0);
		for (const [key, action] of Object.entries(DOCK_KEYMAP)) {
			if (action.kind === "release") continue;
			expect(d.handleKey(key), `key ${JSON.stringify(key)} on empty runs`).toEqual(noop());
		}
		expect(d.handleKey("\x1b")).toEqual({ kind: "release" });
	});

	test("empty runs: abort cannot arm", () => {
		const d = createDockFocus(() => 0);
		expect(d.handleKey("x")).toEqual(noop());
		expect(d.isArmed()).toBe(false);
	});

	test("selected getter clamps when runCount shrinks", () => {
		let runs = 5;
		const d = createDockFocus(() => runs);
		for (let i = 0; i < 3; i++) d.handleKey("j");
		expect(d.selected).toBe(3);
		runs = 1;
		expect(d.selected).toBe(0); // re-clamped on read
		runs = 3;
		expect(d.selected).toBe(2); // still in bounds after the list grows back
	});

	test("unknown keys are noop (incl. the A2-side Ctrl-G prefix byte)", () => {
		const d = createDockFocus(() => 3);
		expect(d.handleKey("q")).toEqual(noop());
		expect(d.handleKey("\x07")).toEqual(noop()); // focus-claim entry is PART A2 wiring
	});
});
