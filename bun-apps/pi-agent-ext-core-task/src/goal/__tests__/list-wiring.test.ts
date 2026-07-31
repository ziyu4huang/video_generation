/**
 * Integration test for the `/list` command wiring (Loop 2, Task 5b).
 *
 * Drives the `/list` command registered by `goal()` directly via the captured
 * `commands.get("list").handler(args, ctx)`, exactly like goal.test.ts drives
 * `/goal`. The fake-`pi`/`ctx`/overlay harness is copied verbatim from
 * goal.test.ts (createMockPi / createMockCtx) + hardening-loop.test.ts
 * (createMockOverlay) — DO NOT invent a new harness.
 *
 * Covers the 5 handlers against `goalState.list` + the pure `list.ts` ops:
 *   - /list add (no active goal)  → first item becomes head (started), rest fill tail
 *   - /list add (active goal)     → appends to tail only (head unchanged)
 *   - /list next                  → parks head (parked=true) + promotes next; headAdvances +1
 *   - /list remove <n> + /list clear
 *   - /list (show)                → renders head + indexed tail via ctx.ui.notify
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalOverlayLike } from "../overlay.js";
import goal, { type StatusContext } from "../goal.js";
import { goalState, __resetGoalState, createGoal } from "../state.js";

// ─── Mock pi/ctx/overlay (mirrors goal.test.ts + hardening-loop.test.ts) ──────
// Copied verbatim from goal.test.ts (createMockPi / createMockCtx) so the `/list`
// command — registered by `goal(pi)` alongside `/goal` — is captured in
// `commands`, and startGoal's full path (persistGoal→appendEntry,
// sendGoalPrompt→sendUserMessage, updateStatus→sync timers) is satisfied.

function createMockPi() {
	const commands = new Map<string, { description?: string; handler: (...args: unknown[]) => unknown; getArgumentCompletions?: (prefix: string) => unknown }>();
	const tools: unknown[] = [];
	const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const sentUserMessages: Array<{ text: string; options?: unknown }> = [];

	const rawPi = {
		registerCommand(name: string, cmd: unknown) {
			commands.set(name, cmd as never);
		},
		registerTool(tool: unknown) {
			tools.push(tool);
		},
		on(event: string, handler: (...args: unknown[]) => unknown) {
			if (!events.has(event)) events.set(event, []);
			events.get(event)!.push(handler);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
		sendUserMessage(text: string, options?: unknown) {
			sentUserMessages.push({ text, options });
		},
	};

	return {
		pi: rawPi as unknown as ExtensionAPI,
		commands,
		tools,
		events,
		entries,
		sentUserMessages,
	};
}

function createMockCtx(overrides: Record<string, unknown> = {}) {
	const notifications: Array<{ message: string; level?: string }> = [];
	const statuses = new Map<string, string | undefined>();

	const sessionManager = overrides.sessionManager ?? {
		getBranch: () => [],
		getEntries: () => [],
	};

	const ctx = {
		cwd: overrides.cwd ?? process.cwd(),
		ui: {
			notify(message: string, level?: string) {
				notifications.push({ message, level });
			},
			setStatus(key: string, value: string | undefined) {
				statuses.set(key, value);
			},
			confirm: overrides.confirm ?? (async (_title: string, _message: string) => true),
		},
		isIdle: overrides.isIdle ?? (() => true),
		hasPendingMessages: overrides.hasPendingMessages ?? (() => false),
		abort: overrides.abort ?? (() => undefined),
		sessionManager,
	};

	return { ctx: ctx as unknown as StatusContext, notifications, statuses };
}

function createMockOverlay(): { impl: GoalOverlayLike } {
	const impl: GoalOverlayLike = {
		setUICtx() {},
		update() {},
		showCompletion() {},
		dispose() {},
	};
	return { impl };
}

// ─── Harness ─────────────────────────────────────────────────────────────────
// Module singleton state + timers are shared across tests, so each test rebuild
// the harness in beforeEach and tears it down (session_shutdown stops the
// status/heartbeat intervals started by updateStatus) in afterEach.

let mock!: ReturnType<typeof createMockPi>;
let ctx!: StatusContext;
let notifications!: Array<{ message: string; level?: string }>;

beforeEach(() => {
	__resetGoalState();
	// Isolate the /list-wiring feature (Loop 2) from the default-ON Reviewer
	// (Task 5): these tests assert the pre-Reviewer completion contract.
	goalState.reviewerEnabled = false;
	mock = createMockPi();
	goal(mock.pi, createMockOverlay().impl);
	({ ctx, notifications } = createMockCtx());
});

afterEach(() => {
	const shutdown = mock.events.get("session_shutdown")?.[0] as
		| ((event: unknown, ctx: unknown) => void)
		| undefined;
	shutdown?.({}, ctx);
	__resetGoalState();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("/list wiring", () => {
	test("/list add with no active goal → first item becomes head (started), rest fill tail", async () => {
		await mock.commands.get("list")!.handler('add "ship A" "do B" "then C"', ctx);

		expect(goalState.activeGoal?.text).toBe("ship A");
		expect(goalState.list.map((i) => i.text)).toEqual(["do B", "then C"]);
		// The head was started → a goal prompt was sent via pi.sendUserMessage.
		expect(mock.sentUserMessages.length).toBeGreaterThan(0);
		// The head persist snapshots head + tail together (one goal-state entry).
		const lastEntry = mock.entries.at(-1);
		expect(lastEntry?.customType).toBe("goal-state");
		expect((lastEntry?.data as { list?: { text: string }[] }).list?.map((i) => i.text)).toEqual(["do B", "then C"]);
	});

	test("/list add with an active goal → appends to tail only (head unchanged)", async () => {
		// Seed an active head via /list add (no-active path), then append more.
		await mock.commands.get("list")!.handler('add "head one"', ctx);
		expect(goalState.activeGoal?.text).toBe("head one");
		expect(goalState.list).toEqual([]);

		await mock.commands.get("list")!.handler('add "tail a" "tail b"', ctx);

		// Head untouched; tail holds the two new items.
		expect(goalState.activeGoal?.text).toBe("head one");
		expect(goalState.list.map((i) => i.text)).toEqual(["tail a", "tail b"]);
		// Appending to an active goal does NOT start a new goal prompt.
		expect(mock.sentUserMessages.length).toBe(1);
	});

	test("/list next → parks head (parked=true) + promotes next; headAdvances +1", async () => {
		await mock.commands.get("list")!.handler('add "a" "b" "c"', ctx);
		// head=a, tail=[b,c]
		expect(goalState.activeGoal?.text).toBe("a");
		expect(goalState.list.map((i) => i.text)).toEqual(["b", "c"]);

		await mock.commands.get("list")!.handler("next", ctx);

		// Promoted the next tail item to the head.
		expect(goalState.activeGoal?.text).toBe("b");
		// The old head is parked at the tail (preserved, parked=true); remaining
		// tail items shift forward.
		expect(goalState.list.map((i) => i.text)).toEqual(["c", "a"]);
		expect(goalState.list[1]?.parked).toBe(true);
		expect(goalState.list[0]?.parked).toBeFalsy();
		expect(goalState.headAdvances).toBe(1);
		// A fresh goal prompt was sent for the promoted head.
		expect(mock.sentUserMessages.length).toBeGreaterThan(1);
	});

	test("/list next with no tail → notifies 'nothing to advance to' and leaves head", async () => {
		await mock.commands.get("list")!.handler('add "only"', ctx);
		expect(goalState.activeGoal?.text).toBe("only");
		expect(goalState.list).toEqual([]);

		await mock.commands.get("list")!.handler("next", ctx);

		// No tail to promote → head unchanged, a warning surfaced.
		expect(goalState.activeGoal?.text).toBe("only");
		expect(notifications.some((n) => /nothing to advance/i.test(n.message))).toBe(true);
	});

	test("/list remove <n> + /list clear", async () => {
		await mock.commands.get("list")!.handler('add "a" "b" "c"', ctx);
		// head=a, tail=[b,c] → /list show renders `1. a`, `2. b`, `3. c`.

		// /list show numbers head=1, tail=2,3,… so "remove 2" deletes the item
		// SHOWN at display index 2 ("b"), leaving tail=["c"]. removeListItem is
		// 1-based on the tail; the handler translates display index → tail index
		// (tailIndex = display - 1), so display 2 → tail slot 1.
		await mock.commands.get("list")!.handler("remove 2", ctx);
		expect(goalState.list.map((i) => i.text)).toEqual(["c"]);
		expect(goalState.activeGoal?.text).toBe("a"); // head untouched

		// Out-of-range remove is a no-op + warning.
		await mock.commands.get("list")!.handler("remove 99", ctx);
		expect(goalState.list.map((i) => i.text)).toEqual(["c"]);
		expect(notifications.some((n) => /no item at index 99/i.test(n.message))).toBe(true);

		// clear wipes the tail; the active head is untouched.
		await mock.commands.get("list")!.handler("clear", ctx);
		expect(goalState.list).toEqual([]);
		expect(goalState.activeGoal?.text).toBe("a");
		expect(notifications.some((n) => /queue cleared/i.test(n.message))).toBe(true);
	});

	test("/list add with a complete head → appends to the tail (existing tail preserved)", async () => {
		// Reachable pre-Task-6: the head is complete but a pending tail still
		// exists. /list add must APPEND to the existing tail, not rebuild it from
		// [] (which would silently discard pending items). texts[0] becomes the new
		// head via startGoal; texts.slice(1) fills the tail — so "old" survives
		// AND "new" is appended.
		goalState.activeGoal = { ...createGoal("done", undefined, 0), status: "complete" };
		goalState.list = [{ id: "old-id", text: "old" }];

		await mock.commands.get("list")!.handler('add "fresh head" "new"', ctx);

		// Existing tail "old" is PRESERVED; "new" (from slice(1)) is appended.
		expect(goalState.list.map((i) => i.text)).toEqual(["old", "new"]);
		// The complete head was replaced by the fresh head (startGoal skips the
		// replace-confirm because the prior head was complete).
		expect(goalState.activeGoal?.text).toBe("fresh head");
		expect(goalState.activeGoal?.status).toBe("active");
	});

	test("/list (show) → renders head + indexed tail via ctx.ui.notify", async () => {
		await mock.commands.get("list")!.handler('add "a" "b" "c"', ctx);

		// Bare /list → show (args is the empty remainder after the slash command).
		await mock.commands.get("list")!.handler("", ctx);

		const show = notifications.at(-1);
		expect(show?.message).toMatch(/1\. a/);
		expect(show?.message).toMatch(/2\. b/);
		expect(show?.message).toMatch(/3\. c/);
		expect(show?.message).toMatch(/\(active\)/);
	});

	test("/list (show) with no active goal → reports '(no active goal)'", async () => {
		await mock.commands.get("list")!.handler("", ctx);
		const show = notifications.at(-1);
		expect(show?.message).toMatch(/no active goal/i);
	});

	test("/list add with no texts → notifies 'Nothing to add' and is a no-op", async () => {
		await mock.commands.get("list")!.handler("add", ctx);
		expect(goalState.activeGoal).toBeUndefined();
		expect(goalState.list).toEqual([]);
		expect(notifications.some((n) => /nothing to add/i.test(n.message))).toBe(true);
	});
});

// ─── goal_complete driver (mirrors list-advance.test.ts) ─────────────────────
// The /goal command registers the goal_complete tool; mock.tools[0] captures it.
// Used by the drained-queue reset test below to drive a clean complete.

interface GoalTool {
	execute: (...args: unknown[]) => Promise<{ content?: Array<{ type: string; text: string }>; terminate?: boolean }>;
}

async function callGoalComplete(summary: string) {
	const tool = mock.tools[0] as GoalTool | undefined;
	if (!tool) throw new Error("goal_complete tool not registered");
	return tool.execute("call", { summary }, new AbortController().signal, () => undefined, ctx);
}

// ─── queue-lifecycle resets (Loop 2 final-fix: list + headAdvances) ─────────
// The in-memory `goalState.list` + `goalState.headAdvances` are queue-lifecycle
// state. They must reset at every lifecycle boundary so (1) a bare /goal after
// a /goal clear shows no phantom ☰ …/2 suffix (zero-regression invariant), and
// (2) the widget position doesn't inflate across drained queues. These drive
// BOTH the /goal + /list command handlers (captured in `commands`).
describe("queue-lifecycle resets (list + headAdvances)", () => {
	test("/goal clear then bare /goal \"c\" → no phantom queue (list=[] , headAdvances=0)", async () => {
		// Seed a queue + bump headAdvances so a missing reset would leak a
		// phantom ☰ …/2 widget suffix on the later bare /goal.
		await mock.commands.get("list")!.handler('add "a" "b" "c"', ctx);
		await mock.commands.get("list")!.handler("next", ctx);
		expect(goalState.activeGoal?.text).toBe("b"); // head promoted
		expect(goalState.headAdvances).toBe(1);
		expect(goalState.list.length).toBe(2);

		// /goal clear → clearGoal (active-head branch) → clearActiveGoal resets.
		await mock.commands.get("goal")!.handler("clear", ctx);
		expect(goalState.activeGoal).toBeUndefined();
		expect(goalState.list).toEqual([]);
		expect(goalState.headAdvances).toBe(0);

		// bare /goal "fresh" → case "start" resets again (fresh single-goal intent).
		await mock.commands.get("goal")!.handler('"fresh goal"', ctx);
		expect(goalState.activeGoal?.text).toBe("fresh goal");
		// Zero-regression invariant: a bare /goal is a fresh single goal —
		// no phantom ☰ suffix, position not inflated.
		expect(goalState.list).toEqual([]);
		expect(goalState.headAdvances).toBe(0);
	});

	test("drained queue then /list add → headAdvances resets (position not inflated)", async () => {
		// Build a queue: head=A, tail=[B]. /list add's no-active-goal branch sets
		// headAdvances=0 (fresh queue head).
		await mock.commands.get("list")!.handler('add "A" "B"', ctx);
		expect(goalState.activeGoal?.text).toBe("A");
		expect(goalState.list.map((i) => i.text)).toEqual(["B"]);
		expect(goalState.headAdvances).toBe(0);

		// Complete A → auto-advance to B (headAdvances bumps to 1).
		await callGoalComplete("A done.");
		expect(goalState.activeGoal?.text).toBe("B");
		expect(goalState.headAdvances).toBe(1);

		// Complete B with an empty tail → drains the queue (clearActiveGoal).
		await callGoalComplete("B done.");
		expect(goalState.activeGoal).toBeUndefined();
		// headAdvances only ever increments in production; without the lifecycle
		// reset it would stay inflated at 1 across drained queues.
		expect(goalState.headAdvances).toBe(0);

		// /list add starts a fresh queue → position must reset to 0, not inherit
		// the stale value (the widget would otherwise mis-state its position).
		await mock.commands.get("list")!.handler('add "x"', ctx);
		expect(goalState.activeGoal?.text).toBe("x");
		expect(goalState.headAdvances).toBe(0);
	});
});
