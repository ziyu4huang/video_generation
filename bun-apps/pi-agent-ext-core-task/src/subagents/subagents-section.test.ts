/**
 * subagents-section.test.ts — snapshots for the order-4 `subagents` section
 * of the composite CoreTaskStatusWidget (Task 01 of the CC-style subagent TUI
 * plan). The section renders ONLY background runs
 * (`registry.views({ foreground: false })`); foreground runs stay inline
 * (Surface A) and never appear here (exclusion rule, REVIEW §4).
 *
 * RunViews are hand-built object literals matching the RunView interface.
 * costUsd/tokensIn/tokensOut are literal zeros NOW (`// Task 03`) so Task 03's
 * RunView extension needs no test churn.
 */
import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { RunView } from "@repo/pi-agent-ext-core-runtime";
import { createSubagentsSection } from "./subagents-section.ts";

// Plain theme (same trick as status-widget.test.ts): every method returns its
// last string arg → uncolored, deterministic output.
const plainTheme = new Proxy(
	{},
	{
		get: () =>
			(...args: unknown[]) => {
				for (let i = args.length - 1; i >= 0; i--) if (typeof args[i] === "string") return args[i];
				return "";
			},
	},
) as unknown as Theme;

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

const noopInterval = (() => 0) as unknown as typeof setInterval;
const noopClearInterval = (() => {}) as unknown as typeof clearInterval;

function makeSection(getViews: () => RunView[]) {
	let renders = 0;
	const handle = createSubagentsSection({
		getViews,
		requestRender: () => {
			renders++;
		},
		setInterval: noopInterval,
		clearInterval: noopClearInterval,
		bell: () => {},
	});
	return { handle, renders: () => renders };
}

describe("subagents section (order 4)", () => {
	test("renders zero lines when view list is empty", () => {
		const { handle } = makeSection(() => []);
		expect(handle.section.render(plainTheme, 100)).toEqual([]);
	});

	test("renders one row per background run", () => {
		const views = [
			fakeView(),
			fakeView({ id: "run-2", actor: "implementer", modelSeg: "opus", elapsedMs: 4_000, toolCallCount: 1, latestAction: "Editing widget.ts" }),
		];
		const { handle } = makeSection(() => views);
		expect(handle.section.render(plainTheme, 100)).toEqual([
			" 2 background runs",
			"  ● researcher sonnet · 12.3s · 3 calls — Reading plan.md",
			"  ● implementer opus · 4.0s · 1 call — Editing widget.ts",
		]);
	});

	test("renders 1 run with singular header", () => {
		const { handle } = makeSection(() => [fakeView()]);
		expect(handle.section.render(plainTheme, 100)).toEqual([
			" 1 background run",
			"  ● researcher sonnet · 12.3s · 3 calls — Reading plan.md",
		]);
	});

	test("row for a run with history renders the latest message line indented beneath", () => {
		const views = [fakeView({ history: [{ role: "assistant", kind: "text", text: "summarizing findings" }] })];
		const { handle } = makeSection(() => views);
		expect(handle.section.render(plainTheme, 100)).toEqual([
			" 1 background run",
			"  ● researcher sonnet · 12.3s · 3 calls — Reading plan.md",
			'    ↳ "summarizing findings"',
		]);
	});

	test("no latest line when history is empty", () => {
		const { handle } = makeSection(() => [fakeView()]);
		const lines = handle.section.render(plainTheme, 100);
		expect(lines).toEqual([" 1 background run", "  ● researcher sonnet · 12.3s · 3 calls — Reading plan.md"]);
		expect(lines.some((l) => l.includes("↳"))).toBe(false);
	});

	test("section id is subagents, order is 4", () => {
		const { handle } = makeSection(() => []);
		expect(handle.section.id).toBe("subagents");
		expect(handle.section.order).toBe(4);
	});

	test("notifyLine renders as top line when set, then clears", () => {
		let views: RunView[] = [];
		const { handle } = makeSection(() => views);
		handle.setNotifyLine("✔ researcher finished");
		expect(handle.section.render(plainTheme, 100)[0]).toBe("✔ researcher finished");
		handle.setNotifyLine(undefined);
		expect(handle.section.render(plainTheme, 100)).toEqual([]);
		// notifyLine alone (no views) still renders — Task 02 fills the trigger.
		handle.setNotifyLine("x");
		expect(handle.section.render(plainTheme, 100)).toEqual(["x"]);
	});

	test("refresh timer requests render only when views are non-empty", () => {
		let views: RunView[] = [];
		let tick: (() => void) | undefined;
		const fakeSetInterval = ((fn: () => void) => {
			tick = fn;
			return 0 as unknown as ReturnType<typeof setInterval>;
		}) as unknown as typeof setInterval;
		let renders = 0;
		const handle = createSubagentsSection({
			getViews: () => views,
			requestRender: () => {
				renders++;
			},
			setInterval: fakeSetInterval,
			clearInterval: noopClearInterval,
		});
		expect(tick).toBeDefined();
		tick?.(); // 0 views → idle-churn guard: no render requested
		expect(renders).toBe(0);
		views = [fakeView()];
		tick?.(); // 1 view → render requested (live elapsed ticks)
		expect(renders).toBe(1);
		handle.dispose();
	});

	describe("SubagentNotify integration (Task 02)", () => {
		test("completion between ticks renders a transient notify line that fades next render", () => {
			let views: RunView[] = [fakeView()];
			const { handle } = makeSection(() => views);
			handle.section.render(plainTheme, 100); // tick 1: running
			views = [fakeView({ status: "done", elapsedMs: 12_300, elapsedFrozen: true, latestAction: "Wrote report" })];
			const out = handle.section.render(plainTheme, 100); // tick 2: completion observed
			expect(out[0]).toContain("researcher");
			expect(out[0]).toContain("12s");
			expect(out[0]).toContain("Wrote report");
			const out2 = handle.section.render(plainTheme, 100); // tick 3: faded
			expect(out2[0]).toBe(" 1 background run");
		});

		test("no notify line while runs stay running", () => {
			const views = [fakeView()];
			const { handle } = makeSection(() => views);
			handle.section.render(plainTheme, 100);
			handle.section.render(plainTheme, 100);
			const out = handle.section.render(plainTheme, 100);
			expect(out[0]).toBe(" 1 background run");
		});
	});

	test("dispose stops the refresh timer", () => {
		let cleared = 0;
		const handle = createSubagentsSection({
			getViews: () => [],
			requestRender: () => {},
			setInterval: noopInterval,
			clearInterval: (() => {
				cleared++;
			}) as unknown as typeof clearInterval,
		});
		handle.dispose();
		expect(cleared).toBe(1);
	});
});
