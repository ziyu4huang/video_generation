/**
 * Tests for the ported pi-goal tool (bun:test + inline mock pi).
 *
 * Ported from @narumitw/pi-goal v0.11.0 test/goal.test.ts.
 * Adapted from node:test + upstream mock pi to bun:test + inline mock.
 *
 * Covers:
 *   - Registration (command, tool, lifecycle hooks)
 *   - Argument completions and command parsing
 *   - Token budget parsing, format helpers
 *   - goal_complete tool: rejection of contradictory summaries, valid completion
 *   - Pause: aborts current turn, blocks stale tools, persists paused state
 *   - Clear: removes goal without aborting, releases stale block
 *   - agent_end: retryable interruptions kept active, non-retryable → paused
 *   - Manual compaction: stale continuation cancelled, fresh one sent
 *   - findFinalAssistantMessage
 *   - validateObjective
 */
import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalOverlayLike } from "../overlay.js";
import goal, {
	buildGoalSystemPrompt,
	completeGoalArguments,
	findFinalAssistantMessage,
	formatDuration,
	formatGoalMetric,
	formatStatus,
	formatTokenCount,
	isContradictoryCompletionSummary,
	isGoalActive,
	isRetryableGoalInterruption,
	planningGateBlocking,
	planProgressLineFromPeer,
	parseCommand,
	parseTokenBudget,
	validateObjective,
	type ActiveGoal,
	type StatusContext,
} from "../goal.js";
import { __resetCoordinator, refreshPlan } from "../../plan/coordinator.js";
import { goalState } from "../state.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Mock pi helpers ─────────────────────────────────────────────────────────

interface GoalTool {
	execute: (...args: unknown[]) => Promise<{
		content?: Array<{ type: string; text: string }>;
		terminate?: boolean;
		details?: Record<string, unknown>;
	}>;
}

function createMockPi() {
	const commands = new Map<string, { description?: string; handler: (...args: unknown[]) => unknown; getArgumentCompletions?: (prefix: string) => unknown }>();
	const tools: GoalTool[] = [];
	const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const sentUserMessages: Array<{ text: string; options?: unknown }> = [];
	let activeTools: string[] = [];

	const rawPi = {
		registerCommand(name: string, cmd: unknown) {
			commands.set(name, cmd as typeof commands extends Map<string, infer V> ? V : never);
		},
		registerTool(tool: unknown) {
			tools.push(tool as GoalTool);
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

function createMockOverlay() {
	let current: ActiveGoal | undefined;
	let completion: string | undefined;
	const impl: GoalOverlayLike = {
		setUICtx() {},
		update(goal) {
			current = goal;
			completion = undefined;
		},
		showCompletion(objective) {
			completion = objective;
		},
		dispose() {
			current = undefined;
			completion = undefined;
		},
	};
	return {
		impl,
		get current() {
			return current;
		},
		get completion() {
			return completion;
		},
	};
}

function lastGoalStatus(mock: ReturnType<typeof createMockPi>) {
	const entry = mock.entries.filter((e) => e.customType === "goal-state").at(-1);
	return ((entry?.data as { goal?: { status?: string } | null } | undefined)?.goal?.status ?? null) as string | null;
}

async function startGoalForTest(overrides: Record<string, unknown> = {}) {
	const mock = createMockPi();
	const overlay = createMockOverlay();
	goal(mock.pi, overlay.impl);
	// These tests pre-date the Reviewer (Task 5) and encode the pre-Reviewer
	// "clean complete -> terminate:true" contract. The Reviewer is a default-ON
	// cross-cutting layer; disable it here so these tests stay scoped to their
	// own feature (audit / planning / auto-advance / completion text).
	goalState.reviewerEnabled = false;
	const { ctx, notifications, statuses } = createMockCtx(overrides);

	const sessionStartHandlers = mock.events.get("session_start");
	if (sessionStartHandlers && sessionStartHandlers.length > 0) {
		await (sessionStartHandlers[0] as (event: unknown, ctx: unknown) => void)({}, ctx);
	}

	const goalCmd = mock.commands.get("goal");
	await goalCmd?.handler("finish", ctx);

	return { mock, ctx, notifications, statuses, overlay };
}

// ─── Status refresh timer ───────────────────────────────────────────────────

describe("status refresh timer", () => {
	test("active goal overlay ticks its elapsed-time metric on a 1s interval and stops on pause", async () => {
		// Task 10 added a second interval (the 15s heartbeat watchdog) alongside
		// this 1s status ticker, so capture ALL registered intervals and select the
		// 1s one explicitly rather than assuming a single setInterval call.
		const intervals: Array<{ fn: () => void; ms: number }> = [];
		let timerHandle = 0;
		let clearCalls = 0;
		const realSetInterval = globalThis.setInterval;
		const realClearInterval = globalThis.clearInterval;
		const realDateNow = Date.now;
		const startedAt = 1_700_000_000_000;
		Date.now = (() => startedAt) as never;
		globalThis.setInterval = ((fn: () => void, ms: number) => {
			intervals.push({ fn, ms });
			timerHandle += 1;
			return timerHandle as never;
		}) as never;
		globalThis.clearInterval = (() => {
			clearCalls += 1;
		}) as never;

		try {
			let updateCalls = 0;
			let currentGoal: ActiveGoal | undefined;
			const overlay: GoalOverlayLike = {
				setUICtx() {},
				update(g) {
					updateCalls++;
					currentGoal = g;
				},
				showCompletion() {},
				dispose() {},
			};
			const mock = createMockPi();
			goal(mock.pi, overlay);
			const { ctx } = createMockCtx({});
			await mock.events.get("session_start")![0]!({}, ctx);
			await mock.commands.get("goal")!.handler("finish", ctx);

			expect(intervals.some((i) => i.ms === 1_000)).toBe(true);
			const tick = intervals.find((i) => i.ms === 1_000)!.fn;
			expect(currentGoal?.status).toBe("active");
			expect(currentGoal?.timeUsedSeconds).toBe(0);

			// Advance the clock 65s and fire the captured refresh tick.
			Date.now = (() => startedAt + 65_000) as never;
			const beforeTick = updateCalls;
			tick?.();
			expect(updateCalls).toBe(beforeTick + 1);
			expect(currentGoal?.timeUsedSeconds).toBe(65);

			// Pausing the goal stops the refresh timer.
			await mock.commands.get("goal")!.handler("pause", ctx);
			expect(clearCalls).toBeGreaterThanOrEqual(1);
		} finally {
			globalThis.setInterval = realSetInterval;
			globalThis.clearInterval = realClearInterval;
			Date.now = realDateNow;
		}
	});
});

// ─── Registration ────────────────────────────────────────────────────────────

describe("registration", () => {
	test("goal registers command, completion tool, and lifecycle hooks", () => {
		const mock = createMockPi();
		goal(mock.pi);

		expect(mock.commands.has("goal")).toBe(true);
		expect(typeof mock.commands.get("goal")?.getArgumentCompletions).toBe("function");
		expect(mock.tools[0]?.execute).toBeDefined();

		const expectedHooks = [
			"agent_end",
			"before_agent_start",
			"input",
			"session_before_compact",
			"session_compact",
			"session_shutdown",
			"session_start",
			"tool_call",
			"tool_execution_end",
		];
		const registered = [...mock.events.keys()].sort();
		expect(registered).toEqual(expectedHooks.sort());
	});
});

// ─── Argument completions ────────────────────────────────────────────────────

describe("completeGoalArguments", () => {
	test("suggests /goal subcommands and token options", () => {
		const all = completeGoalArguments("")!;
		expect(all.map((i) => i.label)).toEqual(["pause", "resume", "clear", "edit", "status", "--tokens", "review"]);
		expect(all.map((i) => i.description)).toEqual([
			"Pause the active goal",
			"Resume a paused or budget-limited goal",
			"Clear the current goal (stop|off|reset|none|cancel also work)",
			"Edit the current goal objective",
			"Show the current goal",
			"Set a token budget before the goal",
			"Set the post-completion Reviewer mode (on|off|auto|aggressive)",
		]);

		expect(completeGoalArguments("pa")?.map((i) => i.value)).toEqual(["pause"]);
		expect(completeGoalArguments("pause")?.map((i) => i.value)).toEqual(["pause"]);
		expect(completeGoalArguments("--t")?.map((i) => i.value)).toEqual(["--tokens "]);
		expect(completeGoalArguments("edit ")?.map((i) => i.value)).toEqual(["edit --tokens "]);
		expect(completeGoalArguments("edit --t")?.map((i) => i.value)).toEqual(["edit --tokens "]);
		expect(completeGoalArguments("ship objective")).toBeNull();
		expect(completeGoalArguments("edit objective")).toBeNull();
	});
});

// ─── Command parsing ─────────────────────────────────────────────────────────

describe("parseCommand", () => {
	test("parses budgets, quoted objectives, and management commands", () => {
		expect(parseCommand('--tokens 1.5k "ship tests"')).toEqual({
			kind: "start",
			objective: "ship tests",
			tokenBudget: 1500,
		});
		expect(parseCommand("edit --tokens 2m revise scope")).toEqual({
			kind: "edit",
			objective: "revise scope",
			tokenBudget: 2_000_000,
		});
		expect(parseCommand("pause")).toEqual({ kind: "pause" });
		expect(parseCommand("pause now")).toBe("Usage: /goal pause");
	});
});

// ─── Token and format helpers ────────────────────────────────────────────────

describe("parseTokenBudget and format helpers", () => {
	test("use compact units", () => {
		expect(parseTokenBudget("250")).toBe(250);
		expect(parseTokenBudget("2.5k")).toBe(2500);
		expect(parseTokenBudget("0")).toBeUndefined();
		expect(formatTokenCount(1500)).toBe("1.5k");
		expect(formatTokenCount(2_000_000)).toBe("2m");
		expect(formatDuration(59)).toBe("59s");
		expect(formatDuration(3660)).toBe("1h1m");
	});
});

// ─── formatStatus ────────────────────────────────────────────────────────────

describe("formatStatus", () => {
	test("reports active, paused, budget-limited, and empty states", () => {
		const activeGoal = {
			id: "g1",
			text: "finish",
			status: "active" as const,
			startedAt: 0,
			updatedAt: 0,
			iteration: 1,
			tokenBudget: 2000,
			tokensUsed: 500,
			timeUsedSeconds: 90,
			baselineTokens: 0,
		};

		expect(formatStatus(undefined)).toBeUndefined();
		expect(formatStatus(activeGoal)).toBe("goal active");
		expect(formatStatus({ ...activeGoal, status: "paused" })).toBe("goal paused");
		expect(formatStatus({ ...activeGoal, status: "budget_limited" })).toBe("goal budget reached");
	});
});

// ─── formatGoalMetric ────────────────────────────────────────────────────────

describe("formatGoalMetric", () => {
	const activeWithBudget = {
		id: "g1",
		text: "finish",
		status: "active" as const,
		startedAt: 0,
		updatedAt: 0,
		iteration: 1,
		tokenBudget: 2000,
		tokensUsed: 500,
		timeUsedSeconds: 90,
		baselineTokens: 0,
	};

	test("budget-bearing states show token usage; others show elapsed", () => {
		// active w/ budget → budget usage
		expect(formatGoalMetric(activeWithBudget)).toBe("500/2k");
		// active w/o budget → elapsed time
		expect(formatGoalMetric({ ...activeWithBudget, tokenBudget: undefined })).toBe("1m");
		// paused → elapsed time (how long it's been running)
		expect(formatGoalMetric({ ...activeWithBudget, status: "paused" })).toBe("1m");
		// budget_limited → budget usage
		expect(formatGoalMetric({ ...activeWithBudget, status: "budget_limited" })).toBe("500/2k");
		// complete → no metric (flash handles display)
		expect(formatGoalMetric({ ...activeWithBudget, status: "complete" })).toBeUndefined();
	});
});

// ─── buildGoalSystemPrompt ───────────────────────────────────────────────────

describe("overlay status updates", () => {
	test("pushes the active goal to the overlay on start", async () => {
		const { overlay } = await startGoalForTest();

		// After starting, the overlay must receive the active goal. No token
		// budget → formatStatus is the bare status word, formatGoalMetric carries
		// the elapsed time.
		const activeGoal = overlay.current;
		expect(activeGoal).toBeDefined();
		expect(activeGoal?.status).toBe("active");
		expect(formatStatus(activeGoal)).toBe("goal active");
		expect(formatGoalMetric(activeGoal)).toMatch(/^\d/);
	});
});

describe("buildGoalSystemPrompt", () => {
	test("escapes objective XML and includes budget rules", () => {
		const prompt = buildGoalSystemPrompt({
			id: "g1",
			text: "fix <all> & verify",
			status: "active",
			startedAt: 0,
			updatedAt: 0,
			iteration: 2,
			tokenBudget: 1000,
			tokensUsed: 250,
			timeUsedSeconds: 0,
			baselineTokens: 0,
		}, "");

		expect(prompt).toMatch(/fix &lt;all&gt; &amp; verify/);
		expect(prompt).toMatch(/Respect the goal token budget \(250\/1k used\)/);
		expect(prompt).toMatch(/Only call the goal_complete tool after/);
	});
});

// ─── goal_complete ───────────────────────────────────────────────────────────

describe("goal_complete", () => {
	// These use the modular-level singleton state, so they must run
	// sequentially within the file. bun:test runs test blocks within a
	// describe in order by default.

	test("rejects contradictory summaries and accepts verified completion", async () => {
		// Unit tests for isContradictoryCompletionSummary
		expect(isContradictoryCompletionSummary("Not complete: tests still fail.")).toBe(true);
		expect(isContradictoryCompletionSummary("Tests still fail.")).toBe(true);
		expect(isContradictoryCompletionSummary("Implemented and verified with npm test.")).toBe(false);
		expect(isContradictoryCompletionSummary("Remaining tasks: none.")).toBe(false);
		expect(isContradictoryCompletionSummary("Could not complete earlier, but now fixed and verified.")).toBe(false);
		expect(isContradictoryCompletionSummary("Was failing before, now passes.")).toBe(false);
		expect(isContradictoryCompletionSummary("Coverage was below threshold, now passes.")).toBe(false);

		const { mock, ctx, overlay } = await startGoalForTest();
		const tool = mock.tools[0]!;

		// Rejected: contradictory summary
		const rejected = await tool.execute(
			"call-1",
			{ summary: "Not complete: tests still fail." },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		expect(rejected.terminate).toBeUndefined();
		expect(rejected.content?.[0]?.text ?? "").toMatch(/rejected/i);
		expect(lastGoalStatus(mock)).toBe("active");

		// Rejected: empty summary
		const emptyRejected = await tool.execute(
			"call-empty",
			{ summary: "   " },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		expect(emptyRejected.terminate).toBeUndefined();
		expect(emptyRejected.content?.[0]?.text ?? "").toMatch(/summary is empty/i);
		expect(lastGoalStatus(mock)).toBe("active");

		// Accepted: valid completion
		const accepted = await tool.execute(
			"call-2",
			{ summary: "Implemented and verified with npm test." },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		expect(accepted.terminate).toBe(true);
		expect(lastGoalStatus(mock)).toBeNull();
		// goal_complete flashes the completion overlay with the objective text.
		expect(overlay.completion).toBe("finish");

		// Rejected: no active goal
		const noActiveRejected = await tool.execute(
			"call-no-active",
			{ summary: "Implemented and verified with npm test." },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		expect(noActiveRejected.terminate).toBeUndefined();
		expect(noActiveRejected.content?.[0]?.text ?? "").toMatch(/no active goal/i);
		expect(lastGoalStatus(mock)).toBeNull();

		// Cleanup: session_shutdown to reset state
		const shutdownHandlers = mock.events.get("session_shutdown");
		if (shutdownHandlers && shutdownHandlers.length > 0) {
			(shutdownHandlers[0] as (event: unknown, ctx: unknown) => void)({}, ctx);
		}
	});
});

// ─── Pause ───────────────────────────────────────────────────────────────────

describe("pause", () => {
	test("aborts the current turn, blocks stale tools, and persists paused state", async () => {
		let pauseAborts = 0;
		const { mock, ctx, overlay } = await startGoalForTest({ abort: () => pauseAborts++ });

		const agentEndHandlers = mock.events.get("agent_end");
		if (agentEndHandlers && agentEndHandlers.length > 0) {
			await (agentEndHandlers[0] as (event: { messages: unknown[] }, ctx: unknown) => Promise<void>)(
				{ messages: [{ role: "assistant", stopReason: "stop" }] },
				ctx,
			);
		}

		const staleContinuation = mock.sentUserMessages.at(-1)?.text ?? "";
		expect(staleContinuation).toMatch(/pi-goal-continuation/);

		const goalCmd = mock.commands.get("goal");
		await goalCmd?.handler("pause", ctx);

		expect(pauseAborts).toBe(1);
		expect(lastGoalStatus(mock)).toBe("paused");
		expect(overlay.current?.status).toBe("paused");

		// Consume stale continuation marker via input handler
		const inputHandlers = mock.events.get("input");
		if (inputHandlers && inputHandlers.length > 0) {
			expect(
				(inputHandlers[0] as (event: { source: string; text: string }) => unknown)({
					source: "extension",
					text: staleContinuation,
				}),
			).toEqual({ action: "handled" });
		}

		// Tool call blocked
		const toolCallHandlers = mock.events.get("tool_call");
		if (toolCallHandlers && toolCallHandlers.length > 0) {
			expect(
				(toolCallHandlers[0] as (event: { toolName: string; toolCallId: string; input: unknown }) => unknown)({
					toolName: "bash",
					toolCallId: "t1",
					input: {},
				}),
			).toEqual({
				block: true,
				reason: "Blocked stale /goal tool call after the goal was paused or interrupted.",
			});
		}
	});
});

// ─── Clear ───────────────────────────────────────────────────────────────────

describe("clear", () => {
	test("removes goal state without aborting or blocking stale tools", async () => {
		let clearAborts = 0;
		const { mock, ctx, overlay } = await startGoalForTest({ abort: () => clearAborts++ });

		const agentEndHandlers = mock.events.get("agent_end");
		if (agentEndHandlers && agentEndHandlers.length > 0) {
			await (agentEndHandlers[0] as (event: { messages: unknown[] }, ctx: unknown) => Promise<void>)(
				{ messages: [{ role: "assistant", stopReason: "stop" }] },
				ctx,
			);
		}

		const staleContinuation = mock.sentUserMessages.at(-1)?.text ?? "";
		expect(staleContinuation).toMatch(/pi-goal-continuation/);

		const goalCmd = mock.commands.get("goal");
		await goalCmd?.handler("clear", ctx);

		expect(clearAborts).toBe(0);
		expect(lastGoalStatus(mock)).toBeNull();
		expect(overlay.current).toBeUndefined();

		// Stale continuation marker is consumed
		const inputHandlers = mock.events.get("input");
		if (inputHandlers && inputHandlers.length > 0) {
			expect(
				(inputHandlers[0] as (event: { source: string; text: string }) => unknown)({
					source: "extension",
					text: staleContinuation,
				}),
			).toEqual({ action: "handled" });
		}

		// Tool call NOT blocked after clear (no stale block)
		const toolCallHandlers = mock.events.get("tool_call");
		if (toolCallHandlers && toolCallHandlers.length > 0) {
			expect(
				(toolCallHandlers[0] as (event: { toolName: string; toolCallId: string; input: unknown }) => unknown)({
					toolName: "edit",
					toolCallId: "t-clear",
					input: {},
				}),
			).toBeUndefined();
		}

		// goal_complete on cleared goal is rejected
		const tool = mock.tools[0]!;
		const staleCompletion = await tool.execute(
			"call-after-clear",
			{ summary: "Implemented and verified." },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		expect(staleCompletion.terminate).toBeUndefined();
		expect(staleCompletion.content?.[0]?.text ?? "").toMatch(/no active goal/i);

		// Cleanup
		const shutdownHandlers = mock.events.get("session_shutdown");
		if (shutdownHandlers && shutdownHandlers.length > 0) {
			(shutdownHandlers[0] as (event: unknown, ctx: unknown) => void)({}, ctx);
		}
	});

	test("clear releases stale tool-call block from a paused goal", async () => {
		let pauseAborts = 0;
		const { mock, ctx, overlay } = await startGoalForTest({ abort: () => pauseAborts++ });

		const agentEndHandlers = mock.events.get("agent_end");
		if (agentEndHandlers && agentEndHandlers.length > 0) {
			await (agentEndHandlers[0] as (event: { messages: unknown[] }, ctx: unknown) => Promise<void>)(
				{ messages: [{ role: "assistant", stopReason: "stop" }] },
				ctx,
			);
		}

		const goalCmd = mock.commands.get("goal");
		await goalCmd?.handler("pause", ctx);

		expect(pauseAborts).toBe(1);
		expect(lastGoalStatus(mock)).toBe("paused");

		// Tool call blocked while paused
		const toolCallHandlers = mock.events.get("tool_call");
		if (toolCallHandlers && toolCallHandlers.length > 0) {
			expect(
				(toolCallHandlers[0] as (event: { toolName: string; toolCallId: string; input: unknown }) => unknown)({
					toolName: "bash",
					toolCallId: "t-paused",
					input: {},
				}),
			).toEqual({
				block: true,
				reason: "Blocked stale /goal tool call after the goal was paused or interrupted.",
			});
		}

		// Clear releases the block
		await goalCmd?.handler("clear", ctx);

		expect(lastGoalStatus(mock)).toBeNull();
		expect(overlay.current).toBeUndefined();
		expect(
			(toolCallHandlers![0] as (event: { toolName: string; toolCallId: string; input: unknown }) => unknown)({
				toolName: "bash",
				toolCallId: "t-after-clear",
				input: {},
			}),
		).toBeUndefined();

		// Cleanup
		const shutdownHandlers = mock.events.get("session_shutdown");
		if (shutdownHandlers && shutdownHandlers.length > 0) {
			(shutdownHandlers[0] as (event: unknown, ctx: unknown) => void)({}, ctx);
		}
	});
});

// ─── isRetryableGoalInterruption ─────────────────────────────────────────────

describe("isRetryableGoalInterruption", () => {
	test("retryable WebSocket closed", () => {
		expect(
			isRetryableGoalInterruption({ role: "assistant", stopReason: "error", errorMessage: "WebSocket closed 1000" }),
		).toBe(true);
	});

	test("retryable context length exceeded", () => {
		expect(
			isRetryableGoalInterruption({ role: "assistant", stopReason: "error", errorMessage: "prompt is too long: 213462 tokens > 200000 maximum" }),
		).toBe(true);
	});

	test("retryable endpoint max context length", () => {
		expect(
			isRetryableGoalInterruption({ role: "assistant", stopReason: "error", errorMessage: "This endpoint's maximum context length is 128000 tokens. However, you requested about 140000 tokens." }),
		).toBe(true);
	});

	test("retryable context_length_exceeded", () => {
		expect(
			isRetryableGoalInterruption({ role: "assistant", stopReason: "error", errorMessage: "context_length_exceeded" }),
		).toBe(true);
	});

	test("non-retryable ChatGPT usage limit", () => {
		expect(
			isRetryableGoalInterruption({ role: "assistant", stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit." }),
		).toBe(false);
	});

	test("retryable interruption keeps goal active, non-retryable pauses", async () => {
		// Retryable case
		const retryable = await startGoalForTest();
		const agentEndHandlers = retryable.mock.events.get("agent_end");
		if (agentEndHandlers && agentEndHandlers.length > 0) {
			await (agentEndHandlers[0] as (event: { messages: unknown[] }, ctx: unknown) => Promise<void>)(
				{
					messages: [{ role: "assistant", stopReason: "error", errorMessage: "WebSocket closed 1000" }],
				},
				retryable.ctx,
			);
		}

		expect(lastGoalStatus(retryable.mock)).toBe("active");
		expect(retryable.mock.sentUserMessages.length).toBe(1);

		// Tool calls not blocked during retryable error
		const toolCallHandlers = retryable.mock.events.get("tool_call");
		if (toolCallHandlers && toolCallHandlers.length > 0) {
			expect(
				(toolCallHandlers[0] as (event: { toolName: string; toolCallId: string; input: unknown }) => unknown)({
					toolName: "bash",
					toolCallId: "retry-tool",
					input: {},
				}),
			).toBeUndefined();
		}

		// Cleanup
		const shutdownHandlers = retryable.mock.events.get("session_shutdown");
		if (shutdownHandlers && shutdownHandlers.length > 0) {
			(shutdownHandlers[0] as (event: unknown, ctx: unknown) => void)({}, retryable.ctx);
		}

		// Non-retryable case
		let aborts = 0;
		const nonRetryable = await startGoalForTest({ abort: () => aborts++ });
		const agentEndHandlers2 = nonRetryable.mock.events.get("agent_end");
		if (agentEndHandlers2 && agentEndHandlers2.length > 0) {
			await (agentEndHandlers2[0] as (event: { messages: unknown[] }, ctx: unknown) => Promise<void>)(
				{
					messages: [{ role: "assistant", stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit." }],
				},
				nonRetryable.ctx,
			);
		}

		expect(aborts).toBe(1);
		expect(lastGoalStatus(nonRetryable.mock)).toBe("paused");

		const toolCallHandlers2 = nonRetryable.mock.events.get("tool_call");
		if (toolCallHandlers2 && toolCallHandlers2.length > 0) {
			expect(
				(toolCallHandlers2[0] as (event: { toolName: string; toolCallId: string; input: unknown }) => unknown)({
					toolName: "bash",
					toolCallId: "t1",
					input: {},
				}),
			).toEqual({
				block: true,
				reason: "Blocked stale /goal tool call after the goal was paused or interrupted.",
			});
		}

		// Cleanup
		const shutdownHandlers2 = nonRetryable.mock.events.get("session_shutdown");
		if (shutdownHandlers2 && shutdownHandlers2.length > 0) {
			(shutdownHandlers2[0] as (event: unknown, ctx: unknown) => void)({}, nonRetryable.ctx);
		}
	});
});

// ─── Codex retry hint ───────────────────────────────────────────────────────

describe("Codex retry-hinted errors", () => {
	test("agent_end keeps retry-hinted errors active without stale tool blocking", async () => {
		let aborts = 0;
		const retryable = await startGoalForTest({ abort: () => aborts++ });
		const errorMessage =
			"Codex error: An error occurred while processing your request. You can retry your request.\n\n[codex-generic-retry] provider returned error; treating Codex retryable backend failure as retryable.";

		expect(isRetryableGoalInterruption({ role: "assistant", stopReason: "error", errorMessage })).toBe(true);

		const agentEndHandlers = retryable.mock.events.get("agent_end");
		if (agentEndHandlers && agentEndHandlers.length > 0) {
			await (agentEndHandlers[0] as (event: { messages: unknown[] }, ctx: unknown) => Promise<void>)(
				{ messages: [{ role: "assistant", stopReason: "error", errorMessage }] },
				retryable.ctx,
			);
		}

		expect(aborts).toBe(0);
		expect(lastGoalStatus(retryable.mock)).toBe("active");

		const toolCallHandlers = retryable.mock.events.get("tool_call");
		if (toolCallHandlers && toolCallHandlers.length > 0) {
			expect(
				(toolCallHandlers[0] as (event: { toolName: string; toolCallId: string; input: unknown }) => unknown)({
					toolName: "bash",
					toolCallId: "codex-retry-tool",
					input: {},
				}),
			).toBeUndefined();
		}

		// Cleanup
		const shutdownHandlers = retryable.mock.events.get("session_shutdown");
		if (shutdownHandlers && shutdownHandlers.length > 0) {
			(shutdownHandlers[0] as (event: unknown, ctx: unknown) => void)({}, retryable.ctx);
		}
	});
});

// ─── Overflow compaction ────────────────────────────────────────────────────

describe("overflow compaction", () => {
	test("keeps the goal active and does not block retry tools", async () => {
		let aborts = 0;
		const overflow = await startGoalForTest({ abort: () => aborts++ });

		const agentEndHandlers = overflow.mock.events.get("agent_end");
		if (agentEndHandlers && agentEndHandlers.length > 0) {
			await (agentEndHandlers[0] as (event: { messages: unknown[] }, ctx: unknown) => Promise<void>)(
				{
					messages: [{ role: "assistant", stopReason: "error", errorMessage: "prompt is too long: 213462 tokens > 200000 maximum" }],
				},
				overflow.ctx,
			);
		}

		expect(aborts).toBe(0);
		expect(lastGoalStatus(overflow.mock)).toBe("active");
		expect(overflow.mock.sentUserMessages.length).toBe(1);

		const toolCallHandlers = overflow.mock.events.get("tool_call");
		if (toolCallHandlers && toolCallHandlers.length > 0) {
			expect(
				(toolCallHandlers[0] as (event: { toolName: string; toolCallId: string; input: unknown }) => unknown)({
					toolName: "read",
					toolCallId: "retry-tool",
					input: {},
				}),
			).toBeUndefined();
		}

		// Simulate compaction
		const beforeCompactHandlers = overflow.mock.events.get("session_before_compact");
		if (beforeCompactHandlers && beforeCompactHandlers.length > 0) {
			(beforeCompactHandlers[0] as (event: unknown, ctx: unknown) => void)({}, overflow.ctx);
		}

		const sessionCompactHandlers = overflow.mock.events.get("session_compact");
		if (sessionCompactHandlers && sessionCompactHandlers.length > 0) {
			await (sessionCompactHandlers[0] as (event: unknown, ctx: unknown) => Promise<void>)({}, overflow.ctx);
		}

		expect(lastGoalStatus(overflow.mock)).toBe("active");
		expect(overflow.mock.sentUserMessages.length).toBe(1);

		if (toolCallHandlers && toolCallHandlers.length > 0) {
			expect(
				(toolCallHandlers[0] as (event: { toolName: string; toolCallId: string; input: unknown }) => unknown)({
					toolName: "bash",
					toolCallId: "post-compact-retry-tool",
					input: {},
				}),
			).toBeUndefined();
		}

		// Cleanup
		const shutdownHandlers = overflow.mock.events.get("session_shutdown");
		if (shutdownHandlers && shutdownHandlers.length > 0) {
			(shutdownHandlers[0] as (event: unknown, ctx: unknown) => void)({}, overflow.ctx);
		}
	});

	test("compaction with willRetry true does not enqueue a goal continuation", async () => {
		const retrying = await startGoalForTest();

		const beforeCompactHandlers = retrying.mock.events.get("session_before_compact");
		if (beforeCompactHandlers && beforeCompactHandlers.length > 0) {
			(beforeCompactHandlers[0] as (event: { reason?: string; willRetry?: boolean }, ctx: unknown) => void)(
				{ reason: "overflow", willRetry: true },
				retrying.ctx,
			);
		}

		const sessionCompactHandlers = retrying.mock.events.get("session_compact");
		if (sessionCompactHandlers && sessionCompactHandlers.length > 0) {
			await (sessionCompactHandlers[0] as (event: { reason?: string; willRetry?: boolean }, ctx: unknown) => Promise<void>)(
				{ reason: "overflow", willRetry: true },
				retrying.ctx,
			);
		}

		expect(lastGoalStatus(retrying.mock)).toBe("active");
		expect(retrying.mock.sentUserMessages.length).toBe(1);

		// Cleanup
		const shutdownHandlers = retrying.mock.events.get("session_shutdown");
		if (shutdownHandlers && shutdownHandlers.length > 0) {
			(shutdownHandlers[0] as (event: unknown, ctx: unknown) => void)({}, retrying.ctx);
		}
	});
});

// ─── Manual compaction ───────────────────────────────────────────────────────

describe("manual compaction", () => {
	test("cancels stale continuation and sends one fresh continuation", async () => {
		const compacted = await startGoalForTest();

		const agentEndHandlers = compacted.mock.events.get("agent_end");
		if (agentEndHandlers && agentEndHandlers.length > 0) {
			await (agentEndHandlers[0] as (event: { messages: unknown[] }, ctx: unknown) => Promise<void>)(
				{ messages: [{ role: "assistant", stopReason: "stop" }] },
				compacted.ctx,
			);
		}

		const staleContinuation = compacted.mock.sentUserMessages.at(-1)?.text ?? "";
		expect(staleContinuation).toMatch(/pi-goal-continuation/);

		// session_before_compact cancels stale continuation
		const beforeCompactHandlers = compacted.mock.events.get("session_before_compact");
		if (beforeCompactHandlers && beforeCompactHandlers.length > 0) {
			(beforeCompactHandlers[0] as (event: { reason?: string; willRetry?: boolean }, ctx: unknown) => void)(
				{ reason: "threshold", willRetry: false },
				compacted.ctx,
			);
		}

		// Stale continuation marker is consumed via input handler
		const inputHandlers = compacted.mock.events.get("input");
		if (inputHandlers && inputHandlers.length > 0) {
			expect(
				(inputHandlers[0] as (event: { source: string; text: string }) => unknown)({
					source: "extension",
					text: staleContinuation,
				}),
			).toEqual({ action: "handled" });
		}

		// session_compact sends a fresh continuation
		const sessionCompactHandlers = compacted.mock.events.get("session_compact");
		if (sessionCompactHandlers && sessionCompactHandlers.length > 0) {
			await (sessionCompactHandlers[0] as (event: { reason?: string; willRetry?: boolean }, ctx: unknown) => Promise<void>)(
				{ reason: "threshold", willRetry: false },
				compacted.ctx,
			);
		}

		const freshContinuation = compacted.mock.sentUserMessages.at(-1)?.text ?? "";
		expect(compacted.mock.sentUserMessages.length).toBe(3);
		expect(freshContinuation).toMatch(/pi-goal-continuation/);
		expect(freshContinuation).not.toBe(staleContinuation);

		// Fresh continuation is NOT consumed yet (not delivered)
		if (inputHandlers && inputHandlers.length > 0) {
			expect(
				(inputHandlers[0] as (event: { source: string; text: string }) => unknown)({
					source: "extension",
					text: freshContinuation,
				}),
			).toBeUndefined();
		}

		// A second session_compact does NOT send another continuation (continuationPending exists)
		if (sessionCompactHandlers && sessionCompactHandlers.length > 0) {
			await (sessionCompactHandlers[0] as (event: { reason?: string; willRetry?: boolean }, ctx: unknown) => Promise<void>)(
				{ reason: "threshold", willRetry: false },
				compacted.ctx,
			);
		}
		expect(compacted.mock.sentUserMessages.length).toBe(3);

		// Cleanup
		const shutdownHandlers = compacted.mock.events.get("session_shutdown");
		if (shutdownHandlers && shutdownHandlers.length > 0) {
			(shutdownHandlers[0] as (event: unknown, ctx: unknown) => void)({}, compacted.ctx);
		}
	});
});

// ─── findFinalAssistantMessage ──────────────────────────────────────────────

describe("findFinalAssistantMessage", () => {
	test("returns the last assistant with a known stop reason", () => {
		expect(
			findFinalAssistantMessage([
				{ role: "assistant", stopReason: "stop" },
				{ role: "assistant", stopReason: "error", errorMessage: "bad" },
			]),
		).toEqual({
			role: "assistant",
			stopReason: "error",
			errorMessage: "bad",
		});

		const message3 = findFinalAssistantMessage([
			{
				role: "assistant",
				stopReason: "error",
				errorMessage: "context_length_exceeded",
				provider: "openai",
				model: "gpt-test",
				usage: { input: 10, output: 2 } as unknown as Record<string, unknown>,
				timestamp: 123,
			},
		]);

		expect(message3?.role).toBe("assistant");
		expect(message3?.stopReason).toBe("error");
		expect(message3?.errorMessage).toBe("context_length_exceeded");
		expect(message3?.provider).toBe("openai");
		expect(message3?.model).toBe("gpt-test");
		expect(message3?.usage?.input).toBe(10);
		expect(message3?.usage?.output).toBe(2);
		expect(message3?.usage?.cacheRead).toBe(0);
		expect(message3?.usage?.totalTokens).toBe(12);
		expect(message3?.timestamp).toBe(123);
	});
});

// ─── Regression: readonly session entry data ───────────────────────────────

describe("frozen session entry data", () => {
	// The pi runtime may freeze/canonicalize custom entry data. The goal loader
	// must return a mutable copy; otherwise updateGoalUsage(activeGoal) throws
	// "Attempted to assign to readonly property" on the live reference.
	test("loadGoalStateFromSession returns a mutable copy (no readonly crash on /goal status)", async () => {
		const frozenGoal = Object.freeze({
			id: "frozen-1",
			text: "persisted goal",
			status: "active",
			startedAt: Date.now(),
			updatedAt: Date.now(),
			iteration: 1,
			tokensUsed: 10,
			timeUsedSeconds: 5,
			baselineTokens: 0,
		});

		const mock = createMockPi();
		goal(mock.pi);

		const sessionManager = {
			getBranch: () => [
				{ type: "custom", customType: "goal-state", data: Object.freeze({ goal: frozenGoal }) },
			],
			getEntries: () => [],
		};
		const { ctx } = createMockCtx({ sessionManager });

		// session_start loads the goal from the (frozen) entry data.
		const sessionStartHandlers = mock.events.get("session_start");
		if (sessionStartHandlers && sessionStartHandlers.length > 0) {
			(sessionStartHandlers[0] as (event: unknown, ctx: unknown) => void)({}, ctx);
		}

		// /goal status calls updateGoalUsage(activeGoal) — must NOT throw on the frozen ref.
		const goalCmd = mock.commands.get("goal");
		await expect(goalCmd?.handler("", ctx)).resolves.toBeUndefined();

		// goal_complete rejection path also mutates the loaded goal via updateGoalUsage.
		const tool = mock.tools[0]!;
		const rejected = await tool.execute(
			"call-frozen",
			{ summary: "Not complete: tests still fail." },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		expect(rejected.terminate).toBeUndefined();
		expect(rejected.content?.[0]?.text ?? "").toMatch(/rejected/i);

		// Cleanup
		const shutdownHandlers = mock.events.get("session_shutdown");
		if (shutdownHandlers && shutdownHandlers.length > 0) {
			(shutdownHandlers[0] as (event: unknown, ctx: unknown) => void)({}, ctx);
		}
	});
});

// ─── validateObjective ───────────────────────────────────────────────────────

describe("validateObjective", () => {
	test("rejects empty goal", () => {
		expect(validateObjective("")).toBe("Usage: /goal <goal_to_complete>");
	});
});

// ─── Plan A coordination seam: isGoalActive ────────────────────────────────

describe("isGoalActive (Plan A coordination seam)", () => {
	// Module-level singleton state — these must run sequentially and clean up.

	test("false with no goal, true while driving, false when paused / cleared", async () => {
		const mock = createMockPi();
		const overlay = createMockOverlay();
		goal(mock.pi, overlay.impl);
		const { ctx } = createMockCtx();

		const sessionStart = mock.events.get("session_start")?.[0];
		await (sessionStart as (e: unknown, c: unknown) => void)?.({}, ctx);

		// No goal started yet → not active.
		expect(isGoalActive()).toBe(false);

		// Start a goal → active.
		const goalCmd = mock.commands.get("goal");
		await goalCmd?.handler("finish the coordination seam", ctx);
		expect(isGoalActive()).toBe(true);

		// Pause → not actively driving (planning may resume its own continuation).
		await goalCmd?.handler("pause", ctx);
		expect(isGoalActive()).toBe(false);

		// Resume → active again.
		await goalCmd?.handler("resume", ctx);
		expect(isGoalActive()).toBe(true);

		// Clear → not active.
		await goalCmd?.handler("clear", ctx);
		expect(isGoalActive()).toBe(false);

		// Cleanup: reset module singleton for subsequent tests.
		const shutdown = mock.events.get("session_shutdown")?.[0];
		await (shutdown as (e: unknown, c: unknown) => void)?.({}, ctx);
	});

	test("false after goal_complete accepts a valid completion", async () => {
		const { mock, ctx } = await startGoalForTest();
		expect(isGoalActive()).toBe(true);

		const tool = mock.tools[0]!;
		await tool.execute(
			"call-done",
			{ summary: "Implemented and verified with bun test." },
			new AbortController().signal,
			() => undefined,
			ctx,
		);
		expect(isGoalActive()).toBe(false);

		const shutdown = mock.events.get("session_shutdown")?.[0];
		await (shutdown as (e: unknown, c: unknown) => void)?.({}, ctx);
	});
});

// ─── Plan-coordinator temp-dir helper (ticket 09 tracer-bullet 3) ─────────────
// goal.ts now calls the coordinator DIRECTLY (internal-call, ticket 03), so tests
// drive the coordinator's cache via a temp dir + refreshPlan — not globalThis.
function makePlanTmp(planMd?: string): string {
	const tmp = mkdtempSync(join(tmpdir(), "goal-plan-"));
	mkdirSync(join(tmp, ".planning", "eff", "plans"), { recursive: true });
	writeFileSync(join(tmp, ".planning", "eff", "map.md"), "# eff\n");
	if (planMd !== undefined) writeFileSync(join(tmp, ".planning", "eff", "plans", "01.md"), planMd);
	refreshPlan(tmp);
	return tmp;
}
function cleanupPlanTmp(tmp: string): void {
	__resetCoordinator();
	try {
		rmSync(tmp, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}

// ─── Plan A coordination seam: planningGateBlocking + goal_complete gate ─────

describe("planningGateBlocking (Plan A completion gate)", () => {
	let tmp: string;
	afterEach(() => cleanupPlanTmp(tmp));

	test("undefined when no plan is cached (standalone)", () => {
		tmp = makePlanTmp(); // empty effort → no plan
		expect(planningGateBlocking(tmp)).toBeUndefined();
	});

	test("reason string when the plan has open phases", () => {
		tmp = makePlanTmp("# P\n### Task 1: A\n- [ ] do it\n");
		expect(planningGateBlocking(tmp)).toMatch(/incomplete phases/);
	});

	test("undefined when all phases are complete", () => {
		tmp = makePlanTmp("# P\n### Task 1: A\n- [x] done\n");
		expect(planningGateBlocking(tmp)).toBeUndefined();
	});
});

describe("goal_complete planning gate (Plan A integration)", () => {
	test("blocks goal_complete while plan has open phases; releases when the plan completes", async () => {
		const tmp = makePlanTmp("# P\n### Task 1: A\n- [ ] do it\n");
		try {
			const { mock, ctx } = await startGoalForTest({ cwd: tmp });
			const tool = mock.tools[0]!;

			// Blocked: valid summary but plan still open.
			const blocked = await tool.execute(
				"call-block",
				{ summary: "Implemented and verified with bun test." },
				new AbortController().signal,
				() => undefined,
				ctx,
			);
			expect(blocked.terminate).toBeUndefined();
			expect(blocked.content?.[0]?.text ?? "").toMatch(/incomplete phases/);
			expect(blocked.content?.[0]?.text ?? "").toMatch(/close the plan/);
			expect(lastGoalStatus(mock)).toBe("active"); // goal stays active

			// Release: complete the phase → re-parse → plan no longer incomplete.
			writeFileSync(join(tmp, ".planning", "eff", "plans", "01.md"), "# P\n### Task 1: A\n- [x] done\n");
			refreshPlan(tmp);
			const accepted = await tool.execute(
				"call-accept",
				{ summary: "Implemented and verified with bun test." },
				new AbortController().signal,
				() => undefined,
				ctx,
			);
			expect(accepted.terminate).toBe(true);
			expect(lastGoalStatus(mock)).toBeNull();

			const shutdown = mock.events.get("session_shutdown")?.[0];
			await (shutdown as (e: unknown, c: unknown) => void)?.({}, ctx);
		} finally {
			cleanupPlanTmp(tmp);
		}
	});

	test("goal_complete proceeds when no plan is cached (standalone)", async () => {
		const tmp = makePlanTmp(); // empty effort → no plan
		try {
			const { mock, ctx } = await startGoalForTest({ cwd: tmp });
			const tool = mock.tools[0]!;
			const accepted = await tool.execute(
				"call",
				{ summary: "Implemented and verified." },
				new AbortController().signal,
				() => undefined,
				ctx,
			);
			expect(accepted.terminate).toBe(true);
			const shutdown = mock.events.get("session_shutdown")?.[0];
			await (shutdown as (e: unknown, c: unknown) => void)?.({}, ctx);
		} finally {
			cleanupPlanTmp(tmp);
		}
	});
});

// ─── Fusion: goal surfaces the plan roadmap it displaced ──────────────────────

describe("planProgressLineFromPeer + buildGoalSystemPrompt (fusion)", () => {
	test("empty when no plan is cached (standalone goal drive)", async () => {
		const tmp = makePlanTmp(); // empty effort → no plan
		try {
			const { mock, ctx } = await startGoalForTest({ cwd: tmp }); // sets latestCtx.cwd = tmp
			expect(planProgressLineFromPeer()).toBe("");
			const shutdown = mock.events.get("session_shutdown")?.[0];
			await (shutdown as (e: unknown, c: unknown) => void)?.({}, ctx);
		} finally {
			cleanupPlanTmp(tmp);
		}
	});

	test("returns the coordinator summary and buildGoalSystemPrompt surfaces it as a roadmap bullet", async () => {
		const tmp = makePlanTmp("# P\n### Task 1: A\n- [ ] do it\n"); // 1 phase, 0 done → "0/1 phases"
		try {
			const { mock, ctx } = await startGoalForTest({ cwd: tmp });
			expect(planProgressLineFromPeer()).toMatch(/0\/1 phases/);

			const prompt = buildGoalSystemPrompt({
				id: "g-fuse",
				text: "fuse the layers",
				status: "active",
				startedAt: 0,
				updatedAt: 0,
				iteration: 0,
				tokensUsed: 0,
				timeUsedSeconds: 0,
				baselineTokens: 0,
			}, planProgressLineFromPeer());
			// The displaced roadmap is surfaced so a goal-driven agent keeps plan visibility.
			expect(prompt).toMatch(/Active plan progress: 0\/1 phases/);
			expect(prompt).toMatch(/roadmap, not a stopping point/);
			// Three-layer guidance teaches todo+plan as tools to finish, not stops.
			expect(prompt).toMatch(/three cooperating layers/);

			const shutdown = mock.events.get("session_shutdown")?.[0];
			await (shutdown as (e: unknown, c: unknown) => void)?.({}, ctx);
		} finally {
			cleanupPlanTmp(tmp);
		}
	});
});

// ─── Reviewer data-loss regression (core-task-review #04) ───────────────────

describe("reviewer data-loss: ui.confirm throwing after enqueue preserves list", () => {
	test("preserves enqueued list when ui.confirm throws after enqueue (data-loss regression)", async () => {
		const { mock: mockPi, ctx, overlay } = await startGoalForTest({
			// Mock ui.confirm to throw (simulates UI race / IPC error)
			confirm: async (_title: string, _message: string) => {
				throw new Error("UI confirm failed (simulated IPC error)");
			},
		});

		// Enable the reviewer AFTER startGoalForTest (which disables it)
		goalState.reviewerEnabled = true;

		const tool = mockPi.tools[0]!;

		// Call goal_complete with a completion summary that contains TODO/FIXME items.
		// The reviewer will extract these as bug findings and enqueue them to the list.
		// Then ui.confirm will throw, and the catch block should preserve the list.
		const result = await tool.execute(
			"call-reviewer-throw",
			{ summary: "Done, but there are some TODOs left:\n- TODO: fix the leak\n- FIXME: race condition" },
			new AbortController().signal,
			() => undefined,
			ctx,
		);

		// The goal should still complete gracefully (non-fatal error)
		expect(result.terminate).toBe(true);
		expect(lastGoalStatus(mockPi)).toBeNull();

		// KEY ASSERTION: the enqueued list items must SURVIVE the throw
		// This is the regression test for the data-loss bug.
		// The reviewer should have extracted the TODO and FIXME as bug findings
		// and enqueued them, and the catch block should preserve them.
		expect(goalState.list.length).toBeGreaterThan(0);
		// The enqueued items should contain the TODO/FIXME text
		const listTexts = goalState.list.map((item) => item.text).join(" ");
		expect(listTexts).toContain("TODO");
		expect(listTexts).toContain("FIXME");

		// Cleanup: session_shutdown to reset state
		const shutdownHandlers = mockPi.events.get("session_shutdown");
		if (shutdownHandlers && shutdownHandlers.length > 0) {
			(shutdownHandlers[0] as (event: unknown, ctx: unknown) => void)({}, ctx);
		}

		// Reset reviewer state for other tests
		goalState.reviewerEnabled = false;
	});
});
