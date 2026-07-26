/**
 * Loop 3 integration tests (Task 7).
 *
 * Exercises the two integration seams T7 wires into the core-task extension:
 *   1. goal.ts's `agent_end` handler dispatches to `runLoopTick` when a loop is
 *      active INSTEAD of running goal continuation.
 *   2. The `/loop start` command refuses to start while a goal is active
 *      (mutual exclusion via the `__piGoalActive` globalThis seam).
 *
 * The fake-pi harness is ported from `goal/__tests__/goal.test.ts` — same shape:
 * `registerCommand` / `registerTool` / `on(event, fn)` (handler capture) /
 * `sendUserMessage` spy / `appendEntry`. The real `goal()` entry registers the
 * agent_end handler; the real `registerLoop()` registers the `/loop` command —
 * so these tests drive the production wiring, not a re-implemented stub.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import goal, { type StatusContext } from "../../goal/goal.js";
import type { GoalOverlayLike } from "../../goal/overlay.js";
import { __resetGoalState, goalState } from "../../goal/state.js";
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALL_MS } from "../../goal/backoff.js";
import { registerLoop } from "../loop.js";
import type { LoopOverlayLike } from "../overlay.js";
import { __resetLoopState, loopState, createLoop } from "../loop-state.js";

// ─── Fake-pi harness (ported from goal/__tests__/goal.test.ts) ──────────────

interface RegisteredCommand {
	description?: string;
	handler: (...args: unknown[]) => unknown;
	getArgumentCompletions?: (prefix: string) => unknown;
}

function createMockPi() {
	const commands = new Map<string, RegisteredCommand>();
	const tools: Array<{ name?: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
	const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const sentUserMessages: Array<{ text: string; options?: unknown }> = [];
	let activeTools: string[] = [];

	const rawPi = {
		registerCommand(name: string, cmd: unknown) {
			commands.set(name, cmd as RegisteredCommand);
		},
		registerTool(tool: unknown) {
			tools.push(tool as (typeof tools)[number]);
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
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
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

function createMockGoalOverlay() {
	let current: unknown;
	const impl: GoalOverlayLike = {
		setUICtx() {},
		update(goal) {
			current = goal;
		},
		showCompletion() {},
		dispose() {
			current = undefined;
		},
	};
	return {
		impl,
		get current() {
			return current;
		},
	};
}

function createMockLoopOverlay() {
	let current: unknown;
	const impl: LoopOverlayLike = {
		setUICtx() {},
		update(loop) {
			current = loop;
		},
		showStop() {},
		dispose() {
			current = undefined;
		},
	};
	return {
		impl,
		get current() {
			return current;
		},
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("loop 3 integration", () => {
	beforeEach(() => {
		__resetGoalState();
		__resetLoopState();
		(globalThis as Record<string, unknown>).__piGoalActive = undefined;
		(globalThis as Record<string, unknown>).__piKickHeartbeat = undefined;
	});

	afterEach(() => {
		__resetGoalState();
		__resetLoopState();
		(globalThis as Record<string, unknown>).__piGoalActive = undefined;
		(globalThis as Record<string, unknown>).__piKickHeartbeat = undefined;
	});

	test("agent_end dispatches to runLoopTick when a loop is active (not goal continuation)", async () => {
		const mock = createMockPi();
		const goalOverlay = createMockGoalOverlay();
		// Register the real goal extension so its agent_end handler is captured.
		// The T7 branch short-circuits to runLoopTick when isLoopActive().
		goal(mock.pi, goalOverlay.impl);
		// isIdle: false forces sendLoopPrompt onto its followUp delivery branch
		// so the assertion can pin { deliverAs: "followUp" }.
		const { ctx, notifications } = createMockCtx({ isIdle: () => false });

		// Activate a loop directly (no /loop start) so the code path under test
		// is the agent_end dispatch, not the start handler.
		loopState.activeLoop = createLoop({ target: "t", mode: "metricless" });
		const sentBefore = mock.sentUserMessages.length;

		const agentEndHandlers = mock.events.get("agent_end");
		expect(agentEndHandlers?.length).toBe(1);
		await (agentEndHandlers![0] as (event: { messages?: unknown[] }, ctx: unknown) => Promise<void>)(
			{
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "HYPOTHESIS: try caching the lookup" }],
						stopReason: "stop",
					},
				],
			},
			ctx,
		);

		// The loop tick incremented iteration (0 -> 1) …
		expect(loopState.activeLoop).toBeDefined();
		expect(loopState.activeLoop?.iteration).toBe(1);
		// … and dispatched a followUp continuation prompt.
		expect(mock.sentUserMessages.length).toBeGreaterThan(sentBefore);
		expect(mock.sentUserMessages.at(-1)?.options).toMatchObject({ deliverAs: "followUp" });
		// A clean tick emits no warning/error notifications.
		expect(notifications.filter((n) => n.level === "warning" || n.level === "error")).toEqual([]);
	});

	test("/loop start is rejected while a goal is active (mutual exclusion)", async () => {
		// Simulate an active goal via the globalThis seam that core-task.ts
		// publishes (isGoalActive). registerLoop's start handler double-checks it.
		(globalThis as Record<string, unknown>).__piGoalActive = () => true;

		const mock = createMockPi();
		const loopOverlay = createMockLoopOverlay();
		registerLoop(mock.pi, loopOverlay.impl);
		const { ctx, notifications } = createMockCtx({});

		const loopCmd = mock.commands.get("loop");
		expect(loopCmd).toBeDefined();
		await (loopCmd!.handler as (args: string, ctx: unknown) => Promise<void>)('start "improve the spec"', ctx);

		// The warning notify fired …
		expect(notifications.some((n) => n.level === "warning")).toBe(true);
		expect(notifications.some((n) => /goal is active/i.test(n.message))).toBe(true);
		// … and NO loop was created.
		expect(loopState.activeLoop).toBeUndefined();
		expect(mock.sentUserMessages.length).toBe(0);
	});

	test("heartbeat re-fires the LOOP continuation when a loop is active and the session stalls", async () => {
		// Mirror hardening-loop.test.ts's fake-timer harness: stub
		// setInterval/clearInterval/Date.now so we can capture the heartbeat tick
		// callback and advance the clock deterministically past HEARTBEAT_STALL_MS.
		const intervals: Array<{ fn: () => void; ms: number }> = [];
		const realSetInterval = globalThis.setInterval;
		const realClearInterval = globalThis.clearInterval;
		const realDateNow = Date.now;
		const startedAt = 1_700_000_000_000;
		let now = startedAt;
		Date.now = (() => now) as never;
		globalThis.setInterval = ((fn: () => void, ms: number) => {
			intervals.push({ fn, ms });
			return intervals.length as never;
		}) as never;
		globalThis.clearInterval = (() => undefined) as never;

		try {
			// beforeEach's __resetGoalState stamped lastActivityAt with the REAL
			// Date.now(); re-pin it to the frozen clock base so msSinceActivity is
			// well-defined once we advance `now`.
			goalState.lastActivityAt = startedAt;

			const mock = createMockPi();
			const goalOverlay = createMockGoalOverlay();
			const loopOverlay = createMockLoopOverlay();
			// Register goal FIRST so its factory publishes the __piKickHeartbeat seam
			// (syncHeartbeatTimer) that registerLoop's /loop start handler calls to
			// arm heartbeat supervision for the loop.
			goal(mock.pi, goalOverlay.impl);
			registerLoop(mock.pi, loopOverlay.impl);
			const { ctx } = createMockCtx({});

			// session_start publishes latestCtx (the heartbeat callback reads it).
			const sessionStart = mock.events.get("session_start")?.[0];
			await (sessionStart as ((e: unknown, c: unknown) => void) | undefined)?.({}, ctx);

			// /loop start sets loopState.activeLoop and — via the __piKickHeartbeat
			// seam — calls syncHeartbeatTimer, whose widened shouldRun
			// (`goal active || isLoopActive()`) now starts the 15s heartbeat for a
			// loop-only session. It also sends the "Loop started" prompt (msg #1).
			const loopCmd = mock.commands.get("loop");
			expect(loopCmd).toBeDefined();
			await (loopCmd!.handler as (args: string, ctx: unknown) => Promise<void>)('start "improve test names"', ctx);
			expect(loopState.activeLoop).toBeDefined();
			expect(mock.sentUserMessages.length).toBe(1);

			// The generalized heartbeat (15s interval) is now running.
			const heartbeat = intervals.find((i) => i.ms === HEARTBEAT_INTERVAL_MS);
			expect(heartbeat).toBeDefined();

			// Advance past the stall threshold with the session idle (ctx.isIdle()
			// defaults true) and nothing pending -> shouldHeartbeatRefire is true ->
			// dispatch routes to refireLoopContinuation (loop active) ->
			// sendLoopContinuation -> sendUserMessage carries the loop marker.
			now = startedAt + HEARTBEAT_STALL_MS + 1_000;
			const sentBefore = mock.sentUserMessages.length;
			heartbeat!.fn();

			expect(mock.sentUserMessages.length).toBeGreaterThan(sentBefore);
			expect(mock.sentUserMessages.at(-1)?.text ?? "").toMatch(/pi-loop-continuation/);
			// The loop's continuation is now tracked in loopState (not goalState).
			expect(loopState.continuationPending).toBeDefined();
		} finally {
			globalThis.setInterval = realSetInterval;
			globalThis.clearInterval = realClearInterval;
			Date.now = realDateNow;
		}
	});
});
