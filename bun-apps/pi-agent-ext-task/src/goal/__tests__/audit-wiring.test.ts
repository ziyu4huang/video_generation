/**
 * Integration test for the T04 opt-in auditor wiring (Task 5):
 * `goal_complete` runs the auditor and gates completion on the verdict (D3
 * bounded re-loop), plus `startGoal` plumbing (`--audit`) and the `/goal audit`
 * toggle.
 *
 * Mirrors the fake-`pi`/`ctx` harness in goal.test.ts (the goal_complete +
 * planning-gate blocks) + hardening-loop.test.ts. Drives `goal()` directly,
 * starts a goal (audited or not), then calls the registered `goal_complete`
 * tool's execute to exercise the audit hook. A fake auditor is injected via the
 * `__setAuditRunnerForTest` seam so no real model is invoked.
 *
 * The auditor module's verdict logic + safety floors are unit-covered in
 * auditor.test.ts / shield.test.ts; this test asserts the WIRING:
 *   - non-audited goal_complete is byte-for-byte the current path (the audit
 *     runner is never even called).
 *   - approved → completes; disapproved → bounded re-loop (stays active,
 *     finding returned, terminate false); 3× disapprove → pause (escalate);
 *     impossible → completes with a note; error → no complete (infra failure).
 */
import { test, expect, describe } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalOverlayLike } from "../overlay.js";
import goal, { __setAuditRunnerForTest, type StatusContext } from "../goal.js";
import { goalState, __resetGoalState } from "../state.js";
import type { GoalAuditorResult } from "../shield.js";
import { isQuotaRetryPending, cancelQuotaRetry } from "../quota-retry.js";

// ─── Mock pi/ctx/overlay (mirrors goal.test.ts) ──────────────────────────────

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

function lastGoalStatus(mock: ReturnType<typeof createMockPi>): string | null {
	const entry = mock.entries.filter((e) => e.customType === "goal-state").at(-1);
	return ((entry?.data as { goal?: { status?: string } | null } | undefined)?.goal?.status ?? null) as string | null;
}

/** Find the most recent persisted goal-state entry whose goal has the given status. */
function persistedGoalWithStatus(mock: ReturnType<typeof createMockPi>, status: string) {
	return mock.entries
		.map((e) => (e.data as { goal?: { status?: string } & Record<string, unknown> } | undefined)?.goal)
		.find((g) => g?.status === status);
}

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
 */
async function bootstrap(commandArgs: string, runner?: () => Promise<GoalAuditorResult>): Promise<Boot> {
	__resetGoalState();
	// Isolate the audit-wiring feature (T04) from the default-ON Reviewer
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

// ─── Canned auditor verdicts ─────────────────────────────────────────────────

const APPROVED: GoalAuditorResult = { approved: true, disapproved: false, output: "<approved/> all checks pass", model: "fake" };
const DISAPPROVED: GoalAuditorResult = { approved: false, disapproved: true, output: "Work is incomplete: tests still failing.", model: "fake" };
const IMPOSSIBLE: GoalAuditorResult = { approved: false, disapproved: false, impossible: true, impossibleReason: "contradictory objective", output: "<impossible>contradictory objective</impossible>", model: "fake" };
const INFRA_ERROR: GoalAuditorResult = { approved: false, disapproved: false, output: "", model: "fake", error: "no output (auth)" };
const QUOTA_ERROR = { approved: false, disapproved: false, output: "", model: "fake", error: "429 Too Many Requests \u2014 Retry-After: 60" } as const;

// ─── goal_complete audit wiring (D3 bounded re-loop) ─────────────────────────

describe("goal_complete audit wiring (T04 D3)", () => {
	test("non-audited goal: goal_complete is the current path; auditor never invoked", async () => {
		// Inject a runner that THROWS if called — proves the non-audited path
		// never reaches the auditor (byte-for-byte the pre-T04 behavior).
		const { mock, ctx } = await bootstrap("finish the task", async () => {
			throw new Error("auditRunner must NOT be called for non-audited goals");
		});
		try {
			const result = await callGoalComplete(mock, ctx, "Implemented and verified with bun test.");
			expect(result.terminate).toBe(true);
			expect(lastGoalStatus(mock)).toBeNull(); // cleared (complete)
			expect(goalState.activeGoal).toBeUndefined();
		} finally {
			await shutdown(mock, ctx);
		}
	});

	test("audited goal, auditor approves → completes (and records audit history)", async () => {
		const { mock, ctx } = await bootstrap("--audit finish the task", async () => ({ ...APPROVED }));
		try {
			const result = await callGoalComplete(mock, ctx, "Implemented and verified with bun test.");
			expect(result.terminate).toBe(true);
			expect(lastGoalStatus(mock)).toBeNull();
			expect(goalState.activeGoal).toBeUndefined();
			// The completed goal (persisted before clearActiveGoal nulled it)
			// carries the audit history.
			const completed = persistedGoalWithStatus(mock, "complete");
			expect((completed as { auditHistory?: GoalAuditorResult[] } | undefined)?.auditHistory?.length).toBe(1);
		} finally {
			await shutdown(mock, ctx);
		}
	});

	test("audited goal, auditor disapproves → stays active, finding returned, terminate undefined", async () => {
		const { mock, ctx, notifications } = await bootstrap("--audit finish the task", async () => ({ ...DISAPPROVED }));
		try {
			const result = await callGoalComplete(mock, ctx, "Done.");
			expect(result.terminate).toBeUndefined(); // agent continues in-turn to self-correct
			expect(goalState.activeGoal?.status).toBe("active");
			expect(goalState.activeGoal?.auditAttempts).toBe(1);
			expect(result.content?.[0]?.text ?? "").toContain("DISAPPROVED");
			expect(result.content?.[0]?.text ?? "").toContain("tests still failing");
			expect(notifications.some((n) => /disapproved/i.test(n.message))).toBe(true);
		} finally {
			await shutdown(mock, ctx);
		}
	});

	test("3 consecutive disapprovals → goal pauses (escalate to user)", async () => {
		const { mock, ctx, notifications } = await bootstrap("--audit finish the task", async () => ({ ...DISAPPROVED }));
		try {
			await callGoalComplete(mock, ctx, "Attempt 1.");
			expect(goalState.activeGoal?.status).toBe("active");
			expect(goalState.activeGoal?.auditAttempts).toBe(1);

			await callGoalComplete(mock, ctx, "Attempt 2.");
			expect(goalState.activeGoal?.status).toBe("active");
			expect(goalState.activeGoal?.auditAttempts).toBe(2);

			// 3rd disapproval hits AUDIT_MAX_RETRIES → pause + escalate.
			const third = await callGoalComplete(mock, ctx, "Attempt 3.");
			expect(goalState.activeGoal?.status).toBe("paused");
			expect(goalState.activeGoal?.auditAttempts).toBe(3);
			expect(third.terminate).toBeUndefined();
			expect(notifications.some((n) => /paused/i.test(n.message))).toBe(true);
			expect(notifications.some((n) => /3×|attempt 3|3 times/i.test(n.message))).toBe(true);
		} finally {
			await shutdown(mock, ctx);
		}
	});

	test("auditor impossible → completes with a note (objective can never be satisfied)", async () => {
		const { mock, ctx, notifications } = await bootstrap("--audit finish the task", async () => ({ ...IMPOSSIBLE }));
		try {
			const result = await callGoalComplete(mock, ctx, "Done.");
			expect(result.terminate).toBe(true);
			expect(lastGoalStatus(mock)).toBeNull();
			expect(goalState.activeGoal).toBeUndefined();
			expect(notifications.some((n) => /impossible/i.test(n.message))).toBe(true);
		} finally {
			await shutdown(mock, ctx);
		}
	});

	test("auditor infrastructure error → does NOT complete; goal stays active", async () => {
		const { mock, ctx, notifications } = await bootstrap("--audit finish the task", async () => ({ ...INFRA_ERROR }));
		try {
			const result = await callGoalComplete(mock, ctx, "Done.");
			expect(result.terminate).toBeUndefined();
			expect(goalState.activeGoal?.status).toBe("active");
			expect(result.content?.[0]?.text ?? "").toMatch(/could not produce a verdict|infrastructure/i);
			expect(notifications.some((n) => /audit failed/i.test(n.message) && n.level === "warning")).toBe(true);
		} finally {
			await shutdown(mock, ctx);
		}
	});
});

// ─── startGoal plumbing + /goal audit toggle ────────────────────────────────

describe("startGoal audit plumbing + /goal audit toggle", () => {
	test("/goal --audit <obj> starts a goal with auditEnabled=true", async () => {
		const { mock, ctx } = await bootstrap("--audit ship the feature");
		try {
			expect(goalState.activeGoal?.auditEnabled).toBe(true);
			expect(goalState.activeGoal?.text).toBe("ship the feature");
		} finally {
			await shutdown(mock, ctx);
		}
	});

	test("/goal <obj> (no flag) starts a goal with auditEnabled unset", async () => {
		const { mock, ctx } = await bootstrap("ship the feature");
		try {
			expect(goalState.activeGoal?.auditEnabled).toBeUndefined();
		} finally {
			await shutdown(mock, ctx);
		}
	});

	test("/goal audit toggles auditEnabled on the active goal", async () => {
		const { mock, ctx, notifications } = await bootstrap("ship the feature");
		try {
			expect(goalState.activeGoal?.auditEnabled).toBeUndefined();

			const goalCmd = mock.commands.get("goal");
			await goalCmd?.handler("audit", ctx);
			expect(goalState.activeGoal?.auditEnabled).toBe(true);
			expect(notifications.some((n) => /enabled/i.test(n.message))).toBe(true);

			await goalCmd?.handler("audit", ctx);
			expect(goalState.activeGoal?.auditEnabled).toBe(false);
			expect(notifications.some((n) => /disabled/i.test(n.message))).toBe(true);
		} finally {
			await shutdown(mock, ctx);
		}
	});

	test("/goal audit with no active goal notifies 'no active goal'", async () => {
		__resetGoalState();
		const mock = createMockPi();
		const overlay = createMockOverlay();
		goal(mock.pi, overlay.impl);
		const { ctx, notifications } = createMockCtx();
		const sessionStart = mock.events.get("session_start")?.[0];
		await (sessionStart as ((e: unknown, c: unknown) => void) | undefined)?.({}, ctx);

		const goalCmd = mock.commands.get("goal");
		await goalCmd?.handler("audit", ctx);
		expect(notifications.some((n) => /no active goal/i.test(n.message))).toBe(true);

		await shutdown(mock, ctx);
	});
});

describe("goal_complete quota-retry wiring", () => {
	test("quota auditor error \u2192 pause + schedule + terminate:true (no re-loop)", async () => {
		const { mock, ctx } = await bootstrap("--audit finish the task", async () => ({ ...QUOTA_ERROR }));
		try {
			const result = await callGoalComplete(mock, ctx, "Done.");
			expect(goalState.activeGoal?.status).toBe("paused"); // NOT active (no re-loop)
			expect(result.terminate).toBe(true); // load-bearing: stops the in-turn retry
			expect(isQuotaRetryPending()).toBe(true); // a one-shot resume is scheduled
			expect(result.content?.[0]?.text ?? "").toMatch(/quota|rate limit|paused|auto-retry/i);
		} finally {
			cancelQuotaRetry();
			await shutdown(mock, ctx);
		}
	});

	test("non-quota infra error \u2192 existing 're-verify' path (NOT paused, no scheduled retry)", async () => {
		const { mock, ctx } = await bootstrap("--audit finish the task", async () => ({ ...INFRA_ERROR }));
		try {
			cancelQuotaRetry();
			const result = await callGoalComplete(mock, ctx, "Done.");
			expect(goalState.activeGoal?.status).toBe("active"); // unchanged
			expect(result.terminate).toBeUndefined();
			expect(isQuotaRetryPending()).toBe(false);
		} finally {
			cancelQuotaRetry();
			await shutdown(mock, ctx);
		}
	});

	test("disapproved + quota error \u2192 disapproval path owns it (NOT quota-paused)", async () => {
		const both = { approved: false, disapproved: true, output: "incomplete", model: "fake", error: "429 rate limited" } as const;
		const { mock, ctx } = await bootstrap("--audit finish the task", async () => ({ ...both }));
		try {
			const result = await callGoalComplete(mock, ctx, "Done.");
			expect(goalState.activeGoal?.status).toBe("active"); // disapproval re-loop, not quota pause
			expect(goalState.activeGoal?.auditAttempts).toBe(1);
			expect(isQuotaRetryPending()).toBe(false);
			expect(result.terminate).toBeUndefined();
		} finally {
			cancelQuotaRetry();
			await shutdown(mock, ctx);
		}
	});

	test("/goal resume cancels the scheduled quota retry", async () => {
		const { mock, ctx } = await bootstrap("--audit finish the task", async () => ({ ...QUOTA_ERROR }));
		try {
			await callGoalComplete(mock, ctx, "Done.");
			expect(isQuotaRetryPending()).toBe(true);
			const goalCmd = mock.commands.get("goal");
			await goalCmd?.handler("resume", ctx);
			expect(isQuotaRetryPending()).toBe(false);
			expect(goalState.activeGoal?.status).toBe("active");
		} finally {
			cancelQuotaRetry();
			await shutdown(mock, ctx);
		}
	});

	test("session_start cancels a pending quota retry", async () => {
		const { mock, ctx } = await bootstrap("--audit finish the task", async () => ({ ...QUOTA_ERROR }));
		try {
			await callGoalComplete(mock, ctx, "Done.");
			expect(isQuotaRetryPending()).toBe(true);
			await (mock.events.get("session_start")?.[0] as ((e: unknown, c: unknown) => void) | undefined)?.({}, ctx);
			expect(isQuotaRetryPending()).toBe(false);
		} finally {
			cancelQuotaRetry();
			await shutdown(mock, ctx);
		}
	});
});
