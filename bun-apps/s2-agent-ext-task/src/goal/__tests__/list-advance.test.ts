/**
 * Integration test for Task 6 — `goal_complete` auto-advance of the /list queue.
 *
 * On a CLEAN complete (approved / no-audit / impossible-note) with a non-empty
 * tail, goal_complete promotes the next tail item to the active goal and
 * continues in-turn (terminate:false). Freeze cases (audit 3× disapprove →
 * paused; infra error) return EARLY in goal_complete and never reach the
 * success-path advance, so the queue stays put on freeze — this test asserts
 * that control-flow guarantee by control (the tail is unchanged after a pause).
 *
 * Mirrors audit-wiring.test.ts's harness VERBATIM: createMockPi (captures
 * tools), drive `goal(pi)` to load the extension, then invoke the registered
 * `goal_complete` tool via `mock.tools[0]!.execute("call", { summary }, signal,
 * onUpdate, ctx)`. The fake-auditor injection (for the freeze test) uses the
 * exact `__setAuditRunnerForTest` seam audit-wiring.test.ts uses.
 */
import { test, expect, describe } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalOverlayLike } from "../overlay.js";
import goal, { __setAuditRunnerForTest, type StatusContext } from "../goal.js";
import { goalState, __resetGoalState } from "../state.js";
import type { GoalAuditorResult } from "../shield.js";

// ─── Mock pi/ctx/overlay (mirrors audit-wiring.test.ts EXACTLY) ──────────────

interface GoalTool {
	execute: (...args: unknown[]) => Promise<{
		content?: Array<{ type: string; text: string }>;
		terminate?: boolean;
		details?: Record<string, unknown>;
	}>;
}

function createMockPi() {
	const commands = new Map<string, { description?: string; handler: (...args: unknown[]) => unknown }>();
	const tools: GoalTool[] = [];
	const events = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const sentUserMessages: Array<{ text: string; options?: unknown }> = [];

	const rawPi = {
		registerCommand(name: string, cmd: unknown) {
			commands.set(name, cmd as never);
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
	const ctx = {
		cwd: overrides.cwd ?? process.cwd(),
		ui: {
			notify(message: string, level?: string) {
				notifications.push({ message, level });
			},
			confirm: overrides.confirm ?? (async () => true),
		},
		isIdle: overrides.isIdle ?? (() => true),
		hasPendingMessages: overrides.hasPendingMessages ?? (() => false),
		abort: overrides.abort ?? (() => undefined),
		sessionManager: overrides.sessionManager ?? { getBranch: () => [], getEntries: () => [] },
	};
	return { ctx: ctx as unknown as StatusContext, notifications };
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function callGoalComplete(mock: ReturnType<typeof createMockPi>, ctx: StatusContext, summary: string) {
	const tool = mock.tools[0]!;
	return tool.execute("call", { summary }, new AbortController().signal, () => undefined, ctx);
}

interface Boot {
	mock: ReturnType<typeof createMockPi>;
	ctx: StatusContext;
	notifications: Array<{ message: string; level?: string }>;
}

/**
 * Reset state, optionally inject a fake audit runner, register goal, fire
 * session_start, then start a goal with the given `/goal` command args.
 * (Verbatim from audit-wiring.test.ts.)
 */
async function bootstrap(commandArgs: string, runner?: () => Promise<GoalAuditorResult>): Promise<Boot> {
	__resetGoalState();
	// Isolate the auto-advance feature (Task 6) from the default-ON Reviewer
	// (Task 5): these tests assert the pre-Reviewer completion contract.
	goalState.reviewerEnabled = false;
	if (runner) __setAuditRunnerForTest(runner);
	const mock = createMockPi();
	const overlay = createMockOverlay();
	goal(mock.pi, overlay.impl);
	const { ctx, notifications } = createMockCtx();

	const sessionStart = mock.events.get("session_start")?.[0];
	await (sessionStart as ((e: unknown, c: unknown) => void) | undefined)?.({}, ctx);

	const goalCmd = mock.commands.get("goal");
	await goalCmd?.handler(commandArgs, ctx);
	return { mock, ctx, notifications };
}

async function shutdown(mock: ReturnType<typeof createMockPi>, ctx: StatusContext) {
	const handlers = mock.events.get("session_shutdown");
	for (const h of handlers ?? []) {
		await (h as (e: unknown, c: unknown) => void)({}, ctx);
	}
	__setAuditRunnerForTest(undefined);
	__resetGoalState();
}

// ─── Canned auditor verdicts (for the freeze test) ───────────────────────────

const DISAPPROVED: GoalAuditorResult = {
	approved: false,
	disapproved: true,
	output: "Work is incomplete: tests still failing.",
	model: "fake",
};

// ─── goal_complete auto-advance (Task 6) ─────────────────────────────────────

describe("goal_complete auto-advance (Task 6)", () => {
	test("clean complete + non-empty tail → promotes next, headAdvances+1, terminate:false", async () => {
		const { mock, ctx } = await bootstrap("goal A");
		try {
			// Seed a one-item tail; the head (goal A) is non-audited.
			goalState.list = [{ id: "b-id", text: "goal B" }];

			const result = await callGoalComplete(mock, ctx, "Done.");

			// Next tail item is now the active head; the tail is drained.
			expect(goalState.activeGoal?.text).toBe("goal B");
			expect(goalState.list).toEqual([]);
			expect(goalState.headAdvances).toBe(1);
			// In-turn continuation on the new goal — NOT a hard terminate.
			expect(result.terminate).toBe(false);
			// The tool-result message surfaces the advance.
			expect(result.content?.[0]?.text ?? "").toContain("Advanced");
		} finally {
			await shutdown(mock, ctx);
		}
	});

	test("clean complete + empty tail → completes as today (terminate:true, goal cleared)", async () => {
		const { mock, ctx } = await bootstrap("goal A");
		try {
			// No tail → nothing to promote.
			goalState.list = [];

			const result = await callGoalComplete(mock, ctx, "Done.");

			// Pre-Task-6 behavior is preserved when the queue is empty.
			expect(result.terminate).toBe(true);
			expect(goalState.activeGoal).toBeUndefined();
			expect(goalState.headAdvances).toBe(0);
		} finally {
			await shutdown(mock, ctx);
		}
	});

	test("freeze: audit 3× disapprove → goal paused, tail UNCHANGED (no advance)", async () => {
		const { mock, ctx } = await bootstrap("--audit goal A", async () => ({ ...DISAPPROVED }));
		try {
			goalState.list = [{ id: "b-id", text: "goal B" }];

			await callGoalComplete(mock, ctx, "Attempt 1.");
			await callGoalComplete(mock, ctx, "Attempt 2.");
			const third = await callGoalComplete(mock, ctx, "Attempt 3.");

			// 3 consecutive disapprovals pause the goal (escalate to user).
			expect(goalState.activeGoal?.status).toBe("paused");
			expect(third.terminate).toBeUndefined();
			// Freeze guarantee: the queue is untouched — no promote happened.
			expect(goalState.list.map((i) => i.text)).toEqual(["goal B"]);
			expect(goalState.headAdvances).toBe(0);
			// The active head is STILL goal A (paused), not goal B.
			expect(goalState.activeGoal?.text).toBe("goal A");
		} finally {
			await shutdown(mock, ctx);
		}
	});

	test("per-item audit plumbed on promotion (D5)", async () => {
		const { mock, ctx } = await bootstrap("goal A");
		try {
			// A tail item carrying its own audit config; head is non-audited.
			goalState.list = [
				{
					id: "b-id",
					text: "goal B",
					audit: { auditEnabled: true, auditorModel: "x", verificationContract: "y" },
				},
			];

			await callGoalComplete(mock, ctx, "Done.");

			// The promoted head inherits the tail item's audit config so ITS
			// goal_complete runs the auditor (D5).
			expect(goalState.activeGoal?.text).toBe("goal B");
			expect(goalState.activeGoal?.auditEnabled).toBe(true);
			expect(goalState.activeGoal?.auditorModel).toBe("x");
			expect(goalState.activeGoal?.verificationContract).toBe("y");
			expect(goalState.headAdvances).toBe(1);
		} finally {
			await shutdown(mock, ctx);
		}
	});
});
