/**
 * status-widget.test.ts — golden + ordering tests for the composite
 * CoreTaskStatusWidget and its two section renderers (GoalOverlay, TodoOverlay).
 *
 * Covers the A1 gate (fixed stacking order survives re-render) and the A2 gate
 * (deterministic, golden-string section output).
 */
import { test, expect, describe } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CoreTaskStatusWidget, getSharedStatusWidget } from "../status-widget.ts";
import { GoalOverlay } from "../../goal/overlay.ts";
import { TodoOverlay } from "../../todo/overlay.ts";
import { replaceState } from "../../todo/state/store.ts";
import type { ActiveGoal } from "../../goal/format.ts";

// Plain theme: any method returns its last string arg, so output is uncolored,
// readable, and deterministic (fg/strikethrough/bold all collapse to raw text).
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

// Minimal fake UI ctx whose setWidget captures the factory so we can drive
// render synchronously (the real SDK invokes the factory on its render cycle).
function captureWidget() {
	let factory: ((tui: unknown, theme: Theme) => { render: (width: number) => string[] }) | undefined;
	const uiCtx = {
		setWidget: (_key: string, content: unknown) => {
			if (content === undefined || typeof content !== "function") factory = undefined;
			else factory = content as typeof factory;
		},
	};
	const render = (width: number) => (factory ? factory(undefined, plainTheme).render(width) : []);
	return { uiCtx, render };
}

const sampleGoal = (over: Partial<ActiveGoal> = {}): ActiveGoal => ({
	id: "g1",
	text: "Ship overlay unification",
	status: "active",
	startedAt: 0,
	updatedAt: 0,
	iteration: 3,
	tokensUsed: 0,
	timeUsedSeconds: 142,
	baselineTokens: 0,
	...over,
});

// ─── Composite ordering (A1) ────────────────────────────────────────────────

describe("CoreTaskStatusWidget ordering", () => {
	test("renders sections in addSection order with a blank separator", () => {
		const w = new CoreTaskStatusWidget();
		const cap = captureWidget();
		w.setUICtx(cap.uiCtx as never);
		w.addSection({ id: "goal", render: () => ["GOAL"] });
		w.addSection({ id: "todo", render: () => ["TODO-1", "TODO-2"] });
		w.update();
		expect(cap.render(40)).toEqual(["GOAL", "", "TODO-1", "TODO-2"]);
	});

	test("order survives repeated update() (the flicker regression)", () => {
		// The old two-key design flickered because clear+re-register moved a key
		// to the end. One composite key cannot reorder relative to itself.
		const w = new CoreTaskStatusWidget();
		const cap = captureWidget();
		w.setUICtx(cap.uiCtx as never);
		w.addSection({ id: "goal", render: () => ["GOAL"] });
		w.addSection({ id: "todo", render: () => ["TODO"] });
		w.update();
		const first = cap.render(40);
		w.update(); // simulate requestRender from either overlay
		w.update();
		expect(cap.render(40)).toEqual(first);
		expect(cap.render(40)).toEqual(["GOAL", "", "TODO"]);
	});

	test("empty sections are skipped (no stray blank lines)", () => {
		const w = new CoreTaskStatusWidget();
		const cap = captureWidget();
		w.setUICtx(cap.uiCtx as never);
		w.addSection({ id: "goal", render: () => [] });
		w.addSection({ id: "todo", render: () => ["TODO"] });
		w.update();
		expect(cap.render(40)).toEqual(["TODO"]);
	});

	test("addSection with a duplicate id is ignored (order preserved)", () => {
		const w = new CoreTaskStatusWidget();
		const cap = captureWidget();
		w.setUICtx(cap.uiCtx as never);
		w.addSection({ id: "goal", render: () => ["G"] });
		w.addSection({ id: "todo", render: () => ["T"] });
		w.addSection({ id: "goal", render: () => ["G2"] }); // ignored
		w.update();
		expect(cap.render(40)).toEqual(["G", "", "T"]);
	});

	test("update() is a safe no-op when UI ctx has no setWidget (RPC/CLI mode)", () => {
		const w = new CoreTaskStatusWidget();
		w.setUICtx({} as never); // no setWidget
		w.addSection({ id: "goal", render: () => ["G"] });
		expect(() => w.update()).not.toThrow();
	});
});

// ─── GoalOverlay golden (A2) ────────────────────────────────────────────────

describe("GoalOverlay.render", () => {
	test("active goal: one line with icon, status word, metric, iter, objective", () => {
		const o = new GoalOverlay();
		o.update(sampleGoal());
		const lines = o.render(plainTheme, 80);
		expect(lines.length).toBe(1);
		const line = lines[0]!;
		expect(line).toContain("🎯");
		expect(line).toContain("goal active"); // status word (colored)
		expect(line).toContain("2m"); // metric: 142s → 2m (dim)
		expect(line).toContain("iter 3");
		expect(line).toContain("Ship overlay unification");
	});

	test("paused goal renders the 'paused' token", () => {
		const o = new GoalOverlay();
		o.update(sampleGoal({ status: "paused" }));
		expect(o.render(plainTheme, 80)[0]!).toContain("paused");
	});

	test("budget-limited goal renders 'budget reached' + usage metric", () => {
		const o = new GoalOverlay();
		o.update(sampleGoal({ status: "budget_limited", tokenBudget: 2000, tokensUsed: 1500 }));
		const line = o.render(plainTheme, 80)[0]!;
		expect(line).toContain("goal budget reached"); // status word (warning)
		expect(line).toContain("1.5k/2k"); // usage metric (dim)
	});

	test("completion flash: '✓ goal complete' + objective", () => {
		const o = new GoalOverlay();
		o.update(sampleGoal());
		o.showCompletion("Ship overlay unification");
		const line = o.render(plainTheme, 80)[0]!;
		expect(line).toContain("✓");
		expect(line).toContain("goal complete");
		expect(line).toContain("Ship overlay unification");
	});

	test("empty when no goal and no flash", () => {
		const o = new GoalOverlay();
		expect(o.render(plainTheme, 80)).toEqual([]);
	});

	test("a new active goal supersedes an active completion flash", () => {
		const o = new GoalOverlay();
		o.showCompletion("old");
		o.update(sampleGoal({ text: "new goal" })); // supersedes flash
		const line = o.render(plainTheme, 80)[0]!;
		expect(line).not.toContain("goal complete");
		expect(line).toContain("new goal");
	});
});

// ─── TodoOverlay golden (A2) ───────────────────────────────────────────────

describe("TodoOverlay.render", () => {
	test("empty list renders nothing", () => {
		replaceState({ tasks: [], nextId: 1 });
		const o = new TodoOverlay();
		expect(o.render(plainTheme, 80)).toEqual([]);
	});

	test("non-empty list: heading + one line per visible task", () => {
		replaceState({
			tasks: [
				{ id: 1, subject: "composite widget", status: "completed" },
				{ id: 2, subject: "refactor overlays", status: "in_progress" },
				{ id: 3, subject: "write tests", status: "pending" },
			],
			nextId: 4,
		});
		const o = new TodoOverlay();
		const lines = o.render(plainTheme, 200); // wide → no truncation
		expect(lines[0]).toContain("Todos (1/3)"); // 1 completed / 3 total
		expect(lines.length).toBe(4); // heading + 3 tasks (last uses └─)
		expect(lines.join("\n")).toContain("composite widget");
		expect(lines.join("\n")).toContain("refactor overlays");
		expect(lines.join("\n")).toContain("write tests");
		expect(lines[3]!).toContain("└─"); // last visible task
	});
});

// ─── Integration: composite + both real overlays ────────────────────────────

describe("composite + real overlays", () => {
	test("goal renders above todo, separated by a blank line", () => {
		replaceState({
			tasks: [{ id: 1, subject: "task one", status: "pending" }],
			nextId: 2,
		});
		const goal = new GoalOverlay();
		const todo = new TodoOverlay();
		const w = new CoreTaskStatusWidget();
		const cap = captureWidget();
		w.setUICtx(cap.uiCtx as never);
		goal.setRefresh(() => w.update());
		todo.setRefresh(() => w.update());
		w.addSection({ id: "goal", render: (t, wd) => goal.render(t, wd) });
		w.addSection({ id: "todo", render: (t, wd) => todo.render(t, wd) });
		goal.update(sampleGoal());
		const lines = cap.render(200);
		expect(lines[0]).toContain("🎯"); // goal first
		expect(lines[1]).toBe(""); // separator
		expect(lines[2]).toContain("Todos"); // todo below
	});
});

// ─── Section ordering by `order` field ─────────────────────────────────────

describe("CoreTaskStatusWidget order field", () => {
	test("sections render sorted by `order`, independent of addSection call order", () => {
		const w = new CoreTaskStatusWidget();
		const cap = captureWidget();
		w.setUICtx(cap.uiCtx as never);
		w.addSection({ id: "wayfind", order: 2, render: () => ["WAYFIND"] });
		w.addSection({ id: "goal", order: 0, render: () => ["GOAL"] });
		w.addSection({ id: "plan", order: 3, render: () => ["PLAN"] });
		w.addSection({ id: "todo", order: 1, render: () => ["TODO"] });
		w.update();
		expect(cap.render(40)).toEqual(["GOAL", "", "TODO", "", "WAYFIND", "", "PLAN"]);
	});

	test("sections without `order` sort after ordered sections, in addSection order", () => {
		const w = new CoreTaskStatusWidget();
		const cap = captureWidget();
		w.setUICtx(cap.uiCtx as never);
		w.addSection({ id: "goal", order: 0, render: () => ["GOAL"] });
		w.addSection({ id: "unordered-a", render: () => ["A"] });
		w.addSection({ id: "unordered-b", render: () => ["B"] });
		w.update();
		expect(cap.render(40)).toEqual(["GOAL", "", "A", "", "B"]);
	});
});

// ─── Singleton getter ───────────────────────────────────────────────────────

	describe("getSharedStatusWidget", () => {
	test("returns the same instance across repeated calls", () => {
		const a = getSharedStatusWidget();
		const b = getSharedStatusWidget();
		expect(a).toBe(b);
	});

	test("the instance is stored on globalThis (survives module-identity gaps)", () => {
		const w = getSharedStatusWidget();
		expect((globalThis as Record<string, unknown>).__piCoreTaskStatusWidget).toBe(w);
	});
});

// ─── Heading count over full store (0/2 bug fix) ───────────────────────

describe("TodoOverlay heading count includes hidden completed tasks", () => {
	test("heading shows REAL progress (completed/total) even when completed tasks are hidden", () => {
		replaceState({
			tasks: [
				{ id: 1, subject: "task A", status: "pending" },
				{ id: 2, subject: "task B", status: "pending" },
				{ id: 3, subject: "task C", status: "completed" },
			],
			nextId: 4,
		});
		const o = new TodoOverlay();
		// First render: completed task #3 is displayed and staged in pendingHide
		o.render(plainTheme, 200);
		// Simulate agent_start: hide completed tasks from the previous turn
		o.hideCompletedTasksFromPreviousTurn();
		// Second render: #3 is now hidden from the list, BUT the heading count
		// must still show 1/3 (real progress), NOT 0/2 (visible-only).
		const lines = o.render(plainTheme, 200);
		expect(lines[0]).toContain("Todos (1/3)");
		expect(lines[0]).not.toContain("0/2");
		// The hidden task #3 should NOT appear in the task list
		expect(lines.join("\n")).not.toContain("task C");
		// But the visible pending tasks should
		expect(lines.join("\n")).toContain("task A");
		expect(lines.join("\n")).toContain("task B");
	});
});

// ─── inspect() debug snapshots ─────────────────────────────────────────

describe("TodoOverlay.inspect", () => {
	test("exposes hidden completed + full task list", () => {
		replaceState({
			tasks: [
				{ id: 1, subject: "visible task", status: "pending" },
				{ id: 2, subject: "hidden task", status: "completed" },
			],
			nextId: 3,
		});
		const o = new TodoOverlay();
		o.render(plainTheme, 200); // stage #2 in pendingHide
		o.hideCompletedTasksFromPreviousTurn(); // move #2 to hidden
		const snap = o.inspect();
		expect(snap.totalTasks).toBe(2);
		expect(snap.visibleTasks).toBe(1);
		expect(snap.hiddenCompletedTaskIds).toEqual([2]);
		expect(snap.fullTaskList).toHaveLength(2);
		expect(snap.fullTaskList.find((t) => t.id === 2)?.status).toBe("completed");
	});
});

describe("CoreTaskStatusWidget.inspect", () => {
	test("returns widget key, registered state, sections, and rendered output", () => {
		const w = new CoreTaskStatusWidget();
		const cap = captureWidget();
		w.setUICtx(cap.uiCtx as never);
		w.addSection({ id: "goal", order: 0, render: () => ["GOAL"] });
		w.addSection({ id: "todo", order: 1, render: () => ["TODO"], inspect: () => ({ totalTasks: 5 }) });
		w.update();
		const snap = w.inspect();
		expect(snap.widgetKey).toBe("pi-core-task");
		expect(snap.registered).toBe(true);
		expect(snap.sections).toHaveLength(2);
		expect(snap.sections[0]).toEqual({ id: "goal", order: 0, detail: undefined });
		expect(snap.sections[1]?.detail).toEqual({ totalTasks: 5 });
		expect(snap.renderedLines).toContain("GOAL");
		expect(snap.renderedLines).toContain("TODO");
	});
});
