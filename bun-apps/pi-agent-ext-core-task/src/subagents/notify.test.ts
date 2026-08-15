/**
 * notify.test.ts — SubagentNotify (Task 02 of the CC-style subagent TUI plan).
 *
 * diff() stamps AT MOST ONE pending line per tick (latest wins):
 *  - prev non-terminal → next terminal  → "✓ <actor> <status> · <elapsed>s · <latestAction>"
 *  - prev foreground:true → next foreground:false → "detached → background · <actor>"
 * Bell fires exactly once per stamped line. take() returns and CLEARS pending
 * lines (fade on next render tick).
 */
import { describe, expect, test } from "bun:test";
import type { RunView } from "@repo/pi-agent-ext-core-runtime";
import { SubagentNotify } from "./notify.ts";

const fakeView = (over: Partial<RunView> = {}): RunView =>
	({
		id: "run-1",
		foreground: false,
		status: "running",
		actor: "researcher",
		modelSeg: "sonnet",
		elapsedMs: 12_300,
		elapsedFrozen: false,
		toolCallCount: 3,
		taskPreview: "Research the plan",
		latestAction: "Reading plan.md",
		history: [],
		startedAt: 0,
		costUsd: 0, // Task 03
		tokensIn: 0, // Task 03
		tokensOut: 0, // Task 03
		...over,
	}) as RunView;

describe("SubagentNotify", () => {
	test("completion stamps line + rings bell once", () => {
		let bells = 0;
		const notify = new SubagentNotify({ bell: () => bells++ });
		const running = fakeView();
		const done = fakeView({ status: "done", elapsedMs: 65_000, elapsedFrozen: true, latestAction: "Wrote report" });
		notify.diff([running], [done]);
		const lines = notify.take();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("researcher");
		expect(lines[0]).toContain("done");
		expect(lines[0]).toContain("65s");
		expect(lines[0]).toContain("Wrote report");
		expect(bells).toBe(1);
		// second take() is empty — take clears
		expect(notify.take()).toEqual([]);
	});

	test("bell not re-rung for an already-terminal run across ticks", () => {
		let bells = 0;
		const notify = new SubagentNotify({ bell: () => bells++ });
		const running = fakeView();
		const done = fakeView({ status: "done", elapsedMs: 65_000, elapsedFrozen: true });
		notify.diff([running], [done]);
		notify.take();
		notify.diff([done], [done]); // terminal → terminal: no new stamp
		expect(notify.take()).toEqual([]);
		expect(bells).toBe(1);
	});

	test("foreground→background flip stamps detached line", () => {
		let bells = 0;
		const notify = new SubagentNotify({ bell: () => bells++ });
		const fg = fakeView({ foreground: true });
		const bg = fakeView({ foreground: false });
		notify.diff([fg], [bg]);
		const lines = notify.take();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("detached → background");
		expect(lines[0]).toContain("researcher");
		expect(bells).toBe(1);
	});

	test("no line when nothing changed", () => {
		const notify = new SubagentNotify({ bell: () => {} });
		const v = fakeView();
		notify.diff([v], [fakeView()]);
		expect(notify.take()).toEqual([]);
	});

	test("take clears — line fades on next render tick", () => {
		const notify = new SubagentNotify({ bell: () => {} });
		const running = fakeView();
		const done = fakeView({ status: "error", elapsedMs: 65_000, elapsedFrozen: true });
		notify.diff([running], [done]);
		expect(notify.take()).toHaveLength(1);
		expect(notify.take()).toEqual([]);
		// and a later tick with no transition stamps nothing new
		notify.diff([done], [done]);
		expect(notify.take()).toEqual([]);
	});
});

// Task 06: the post-detach notify line fires via the foreground-flip rule when
// the ctrl+b dispatch (global or in-viewer — both route through the SAME
// convertToBackground lever) detaches a real foreground registry run.
import { SubagentInFlightRegistry } from "@repo/pi-agent-ext-core-runtime";
import { convertToBackground, dispatchCtrlB } from "@repo/pi-agent-ext-subagent";

describe("SubagentNotify × dispatchCtrlB (Task 06)", () => {
	test("dispatch flip drives exactly one 'detached → background' line", () => {
		let bells = 0;
		const notify = new SubagentNotify({ bell: () => bells++ });
		const registry = new SubagentInFlightRegistry();
		registry.start({
			id: "call-1",
			agent: "implementer",
			task: "the raw task",
			taskPreview: "the raw task",
			model: "provider/model",
			startedAt: Date.now(),
			status: "running",
			foreground: true,
		});
		const prev = registry.views(); // foreground:true snapshot
		const outcome = dispatchCtrlB(registry, (id) =>
			convertToBackground(id, {
				registry,
				spawnDetached: () => ({ pid: 4242, kill: () => {} }),
				persistRun: () => "/tmp/manifest.json",
			}),
		);
		expect(outcome).toEqual({ ok: true, runId: "call-1" });
		notify.diff(prev, registry.views());
		const lines = notify.take();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("detached → background");
		expect(lines[0]).toContain("implementer");
		expect(bells).toBe(1);
		// already-flipped → already-flipped next tick: no second line
		notify.diff(registry.views(), registry.views());
		expect(notify.take()).toEqual([]);
	});
});
