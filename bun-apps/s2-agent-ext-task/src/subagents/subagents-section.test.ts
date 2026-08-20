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
import type { RunView } from "@repo/s2-agent-core-runtime";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createSubagentsSection, DOCK_HINT_LINE } from "./subagents-section.ts";

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

	describe("dock focus render state (Task 08 PART 2)", () => {
		test("selected row gets the ▶ prefix while dock focused; hint line on top", () => {
			const views = [fakeView(), fakeView({ id: "run-2", actor: "implementer", modelSeg: "opus" })];
			const { handle } = makeSection(() => views);
			handle.setDockState({ selected: 1, armed: false, expanded: false });
			const lines = handle.section.render(plainTheme, 100);
			expect(lines[0]).toBe(" ⎇ dock focused · j/k scroll · x abort · e trace · ctrl+b detach · ⏎ viewer · esc release");
			expect(lines[1]).toBe(" 2 background runs");
			expect(lines[2]).toBe("  ● researcher sonnet · 12.3s · 3 calls — Reading plan.md");
			expect(lines[3]).toBe("▶ ● implementer opus · 12.3s · 3 calls — Reading plan.md");
		});

		test("armed state shows the [abort? y/n] marker on the count header", () => {
			const { handle } = makeSection(() => [fakeView()]);
			handle.setDockState({ selected: 0, armed: true, expanded: false });
			const lines = handle.section.render(plainTheme, 100);
			expect(lines[1]).toBe(" 1 background run · [abort? y/n]");
		});

		test("expanded: capped formatSubagentTrace tail renders beneath the selected row", () => {
			// 20 unpaired toolCalls → 20 `→ …` lines + 1 progress line = 21 trace lines;
			// capTraceTail(21, STREAMING_EXPANDED_TAIL=16) → "…" + last 16 = 17 lines.
			const history = Array.from({ length: 20 }, (_, i) => ({
				role: "assistant" as const,
				kind: "toolCall" as const,
				text: "",
				toolName: "read",
				toolCallId: `t${i}`,
			}));
			const views = [fakeView({ id: "run-1", history })];
			const { handle } = makeSection(() => views);
			handle.setDockState({ selected: 0, armed: false, expanded: true });
			const lines = handle.section.render(plainTheme, 100);
			const header = lines.indexOf(" 1 background run");
			expect(header).toBe(1);
			const trace = lines.slice(header + 1).map((l) => l.slice(6)); // strip 6-space indent
			expect(trace).toHaveLength(17);
			expect(trace[0]).toBe("…"); // ellipsis marker when capped
			expect(trace.at(-1)).toContain("20 calls"); // progress line survives the cap
			expect(trace.at(-1)).toContain("12.3s");
		});

		test("expanded with a short history renders uncapped (no ellipsis line)", () => {
			const views = [fakeView({ history: [{ role: "assistant", kind: "text", text: "thinking" }] })];
			const { handle } = makeSection(() => views);
			handle.setDockState({ selected: 0, armed: false, expanded: true });
			const lines = handle.section.render(plainTheme, 100);
			// text entry + progress line, both under the selected row
			const trace = lines.slice(3).map((l) => l.slice(6));
			expect(trace[0]).toBe("thinking");
			expect(trace.at(-1)).toContain("3 calls");
		});

		test("setDockState(undefined) restores plain (unfocused) rendering", () => {
			const views = [fakeView(), fakeView({ id: "run-2", actor: "implementer", modelSeg: "opus" })];
			const { handle } = makeSection(() => views);
			handle.setDockState({ selected: 1, armed: true, expanded: true });
			handle.setDockState(undefined);
			expect(handle.section.render(plainTheme, 100)).toEqual([
				" 2 background runs",
				"  ● researcher sonnet · 12.3s · 3 calls — Reading plan.md",
				"  ● implementer opus · 12.3s · 3 calls — Reading plan.md",
			]);
		});

		test("setDockState requests a render (hint repaint without waiting for the 1s tick)", () => {
			let renders = 0;
			const handle = createSubagentsSection({
				getViews: () => [fakeView()],
				requestRender: () => {
					renders++;
				},
				setInterval: noopInterval,
				clearInterval: noopClearInterval,
			});
			handle.setDockState({ selected: 0, armed: false, expanded: false });
			expect(renders).toBe(1);
			handle.setDockState(undefined);
			expect(renders).toBe(2);
		});
	});

	describe("width-aware rows (Ticket 04)", () => {
		const LONG_ACTION = "a".repeat(80); // > core-runtime's 50-char action cap AND > 40 columns

		test("long latestAction at width 40: every composed line fits the terminal width", () => {
			const { handle } = makeSection(() => [fakeView({ latestAction: LONG_ACTION })]);
			const lines = handle.section.render(plainTheme, 40);
			expect(lines).toHaveLength(2); // header + row (empty history → no quote line)
			expect(lines[0]).toBe(" 1 background run");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
			expect(lines[1]).toContain("..."); // guard truncated + ellipsized
		});

		test("long quote history at width 40: the 4-space-indented quote line fits too", () => {
			const views = [fakeView({ history: [{ role: "assistant", kind: "text", text: "x".repeat(80) }] })];
			const { handle } = makeSection(() => views);
			const lines = handle.section.render(plainTheme, 40);
			expect(lines).toHaveLength(3);
			const quote = lines[2]!;
			expect(quote.startsWith('    ↳ "')).toBe(true);
			expect(visibleWidth(quote)).toBeLessThanOrEqual(40);
			// width - 4 threading (ticket 01 helper) + backstop guard; at a wide
			// terminal the same quote passes through whole and untruncated.
			expect(handle.section.render(plainTheme, 120)[2]).toBe(`    ↳ "${"x".repeat(80)}"`);
		});

		test("CJK (double-width) latestAction at width 40: column-aware fit", () => {
			const { handle } = makeSection(() => [fakeView({ latestAction: "漢".repeat(40) })]); // 80 columns
			const lines = handle.section.render(plainTheme, 40);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		});

		test("width 120: same long view renders byte-identical to the unguarded expectation", () => {
			const { handle } = makeSection(() => [fakeView({ latestAction: LONG_ACTION })]);
			const lines = handle.section.render(plainTheme, 120);
			// core-runtime's own 50-char action cap still binds (49 a's + …); the
			// section-level guard is the identity for lines that already fit.
			expect(lines).toEqual([
				" 1 background run",
				`  ● researcher sonnet · 12.3s · 3 calls — ${"a".repeat(49)}…`,
			]);
			expect(lines).toEqual(handle.section.render(plainTheme, 5000)); // constant binds
		});

		test("dock hint line is exempt: rendered untruncated even at width 20", () => {
			const { handle } = makeSection(() => [fakeView()]);
			handle.setDockState({ selected: 0, armed: false, expanded: false });
			const lines = handle.section.render(plainTheme, 20);
			expect(lines[0]).toBe(DOCK_HINT_LINE); // ~89 columns > 20 — renders as-is
			expect(visibleWidth(lines[0]!)).toBeGreaterThan(20); // exemption proof
			// while the rows themselves ARE fitted at width 20
			for (const line of lines.slice(1)) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
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
