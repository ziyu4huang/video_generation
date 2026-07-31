/**
 * Integration test for the Phase-2 hardening wired into goal.ts's `agent_end`:
 * the backoff cap + anti-repetition loop (Task 9).
 *
 * Mirrors the fake-`pi`/`ctx` harness in goal.test.ts (see the `pause` /
 * `clear` / `agent_end` retry describe blocks). Drives `goal()` directly,
 * starts a goal, then fires `tool_execution_end` + `agent_end` events to
 * exercise the stuck-classification → intervention → 5-stuck pause path.
 *
 * The unit tests in repetition.test.ts / backoff.test.ts already cover the
 * classifier math; this test asserts the WIRING:
 *   1. Near-duplicate assistant turns bump `goalState.consecutiveStuck` and
 *      swap the normal continuation for a STUCK intervention directive.
 *   2. After the 5th stuck iteration the goal is PAUSED (maxInterventions stop).
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalOverlayLike } from "../overlay.js";
import goal, { type StatusContext } from "../goal.js";
import { goalState, __resetGoalState } from "../state.js";
import { textFingerprint } from "../repetition.js";
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALL_MS } from "../backoff.js";
import { LENGTH_CONTINUE_TEXT, resetLengthContinue } from "../length-continue.js";

// ─── Mock pi/ctx/overlay (mirrors goal.test.ts) ──────────────────────────────

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

/** Fire a tool_execution_end event (resets toollessStreak + pushes a tool print). */
async function fireToolEnd(mock: ReturnType<typeof createMockPi>, toolName: string, result: unknown, isError = false) {
	const handlers = mock.events.get("tool_execution_end");
	for (const h of handlers ?? []) {
		await h({ type: "tool_execution_end", toolCallId: `${toolName}-call`, toolName, result, isError }, {});
	}
}

/** Fire an agent_end event carrying a final assistant message with the given text. */
async function fireAgentEnd(mock: ReturnType<typeof createMockPi>, ctx: StatusContext, assistantText: string) {
	const handlers = mock.events.get("agent_end");
	for (const h of handlers ?? []) {
		await h(
			{
				messages: [
					{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: assistantText }] },
				],
			},
			ctx,
		);
	}
}

/** Fire an agent_end carrying a final assistant truncated at the output cap. */
async function fireAgentEndLength(mock: ReturnType<typeof createMockPi>, ctx: StatusContext, text = "x") {
	for (const h of mock.events.get("agent_end") ?? []) {
		await h(
			{ messages: [{ role: "assistant", stopReason: "length", content: [{ type: "text", text }] }] },
			ctx,
		);
	}
}

// A near-duplicate family: each variant differs from the next by exactly one
// trailing word, so consecutive turns have trigram similarity ≈ 0.9 ≥ 0.8
// (the similarityThreshold). Lifted from repetition.test.ts's known-good pair.
const NEAR_DUP_BASE =
	"I will now refactor the goal module by extracting the overflow helpers into a separate file for testability and ";
const VARIANT_LAST_WORD = ["clarity", "readability", "maintainability", "quality", "stability", "portability"];
function nearDup(variant: number): string {
	return NEAR_DUP_BASE + VARIANT_LAST_WORD[variant] + ".";
}

/** Build a started goal + return the harness pieces. */
async function bootstrap() {
	__resetGoalState();
	const mock = createMockPi();
	const overlay = createMockOverlay();
	goal(mock.pi, overlay.impl);
	const { ctx, notifications } = createMockCtx();

	const sessionStart = mock.events.get("session_start")?.[0];
	await (sessionStart as ((e: unknown, c: unknown) => void) | undefined)?.({}, ctx);

	const goalCmd = mock.commands.get("goal");
	await goalCmd?.handler("break the repetition loop", ctx);
	return { mock, ctx, notifications };
}

async function shutdown(mock: ReturnType<typeof createMockPi>, ctx: StatusContext) {
	const shutdownHandlers = mock.events.get("session_shutdown");
	for (const h of shutdownHandlers ?? []) {
		await (h as (e: unknown, c: unknown) => void)({}, ctx);
	}
	__resetGoalState();
}
// ─── Tests ───────────────────────────────────────────────────────────────────

describe("agent_end hardening: anti-repetition + backoff cap", () => {
	test("two near-duplicate turns bump consecutiveStuck to 2 and send a STUCK intervention", async () => {
		const { mock, ctx } = await bootstrap();
		try {
			// Seed rolling windows with a baseline turn so the first near-duplicate
			// has a `previousText` to compare against (similarity needs a prior).
			goalState.recentTexts = [nearDup(0)];
			goalState.recentPrints = [textFingerprint(nearDup(0))];

			// 1st near-duplicate turn: a tool runs (keeps toollessStreak low), then
			// the assistant emits text near-identical to the baseline.
			await fireToolEnd(mock, "bash", { stdout: "first unique result" });
			await fireAgentEnd(mock, ctx, nearDup(1));
			expect(goalState.consecutiveStuck).toBe(1);
			expect(mock.sentUserMessages.at(-1)?.text ?? "").toContain("STUCK");

			// 2nd near-duplicate turn: another tool run + near-identical text.
			await fireToolEnd(mock, "read", { file: "second unique result" });
			await fireAgentEnd(mock, ctx, nearDup(2));
			expect(goalState.consecutiveStuck).toBe(2);
			expect(mock.sentUserMessages.at(-1)?.text ?? "").toContain("STUCK");
		} finally {
			await shutdown(mock, ctx);
		}
	});

	test("5th stuck iteration pauses the goal (maxInterventions stop)", async () => {
		const { mock, ctx, notifications } = await bootstrap();
		try {
			goalState.recentTexts = [nearDup(0)];
			goalState.recentPrints = [textFingerprint(nearDup(0))];

			// Drive 5 stuck turns. Each fires a (varied) tool so toollessStreak stays
			// below the idle threshold — this isolates the maxInterventions stop from
			// the backoff/idle cap.
			for (let i = 1; i <= 5; i++) {
				await fireToolEnd(mock, `tool-${i}`, { output: `result-${i}` });
				await fireAgentEnd(mock, ctx, nearDup(i));
			}

			expect(goalState.consecutiveStuck).toBe(5);
			expect(goalState.activeGoal?.status).toBe("paused");
			// The pause reason flows through ctx.ui.notify (pauseGoalAfterAgentEnd),
			// not pi.sendUserMessage (which only carries continuation prompts).
			expect(notifications.some((n) => /stuck for 5 iterations/.test(n.message))).toBe(true);
		} finally {
			await shutdown(mock, ctx);
		}
	});

	test("tool turn → narration-only turn does NOT false-trigger STUCK (consecutive toolless count fix)", async () => {
		const { mock, ctx } = await bootstrap();
		try {
			// Turn 1: a tool runs, then the assistant narrates (unique, non-repeating).
			await fireToolEnd(mock, "bash", { stdout: "ran the test suite: 12 passing" });
			await fireAgentEnd(mock, ctx, "I ran the tests and they all pass. Next I will update the docs.");
			// A tool ran this turn → toollessStreak must be 0 (not 1), no STUCK.
			expect(goalState.toollessStreak).toBe(0);
			expect(goalState.consecutiveStuck).toBe(0);
			expect(mock.sentUserMessages.at(-1)?.text ?? "").not.toContain("STUCK");

			// Turn 2: narration only (no tool). One lone narration turn must NOT trip
			// the 2-iteration threshold: toollessStreak becomes 1, detectLoopStuck
			// returns undefined, so consecutiveStuck stays 0 and no STUCK is injected.
			// This is exactly the off-by-one the reviewer flagged: before the per-turn
			// flag, toollessStreak was 2 here (1 from turn 1 + 1 from turn 2), firing a
			// premature STUCK intervention on a perfectly normal thinking turn.
			await fireAgentEnd(mock, ctx, "Let me think through the documentation structure before writing anything.");
			expect(goalState.toollessStreak).toBe(1);
			expect(goalState.consecutiveStuck).toBe(0);
			expect(mock.sentUserMessages.at(-1)?.text ?? "").not.toContain("STUCK");
		} finally {
			await shutdown(mock, ctx);
		}
	});
});

// ─── Task 10: heartbeat self-watchdog + wedge alert + nudge cap ───────────────
// The decision math is unit-covered in backoff.test.ts; these assert the WIRING
// into goal.ts: the HEARTBEAT_INTERVAL_MS interval re-fires the continuation
// when the session stalls past HEARTBEAT_STALL_MS, and 3 consecutive no-tool
// turns pause the goal via the nudge cap.

describe("heartbeat self-watchdog + nudge cap (Task 10)", () => {
	test("heartbeat re-fires the continuation when the session stalls past HEARTBEAT_STALL_MS", async () => {
		// Mirror goal.test.ts's status-refresh fake-timer harness: stub
		// setInterval/clearInterval/Date.now so we can capture the tick callback and
		// advance the clock deterministically past the 120s stall threshold.
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

		let mock: ReturnType<typeof createMockPi> | undefined;
		let ctx: StatusContext | undefined;
		try {
			// bootstrap() calls __resetGoalState() -> lastActivityAt = now (frozen at
			// startedAt), then registers handlers, fires session_start, and starts a
			// goal. startGoal sends the goal prompt (msg #1) via sendUserMessage; it
			// does NOT set continuationPending, so timerPending is false.
			const boot = await bootstrap();
			mock = boot.mock;
			ctx = boot.ctx;
			expect(mock.sentUserMessages.length).toBe(1);

			// updateStatus started two intervals (1s status + 15s heartbeat).
			const heartbeat = intervals.find((i) => i.ms === HEARTBEAT_INTERVAL_MS);
			expect(heartbeat).toBeDefined();

			// Advance past the stall threshold with the session idle and no pending
			// continuation -> shouldHeartbeatRefire is true -> sendContinuationPrompt
			// re-fires (msg #2 carries the continuation marker).
			now = startedAt + HEARTBEAT_STALL_MS + 1_000;
			heartbeat!.fn();

			expect(mock.sentUserMessages.length).toBe(2);
			expect(mock.sentUserMessages.at(-1)?.text ?? "").toMatch(/pi-goal-continuation/);
		} finally {
			if (mock && ctx) await shutdown(mock, ctx);
			globalThis.setInterval = realSetInterval;
			globalThis.clearInterval = realClearInterval;
			Date.now = realDateNow;
		}
	});

	test("heartbeat does NOT re-fire while a continuation is already pending", async () => {
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

		let mock: ReturnType<typeof createMockPi> | undefined;
		let ctx: StatusContext | undefined;
		try {
			const boot = await bootstrap();
			mock = boot.mock;
			ctx = boot.ctx;

			// A normal turn enqueues a continuation (sets continuationPending), so
			// timerPending becomes true and the heartbeat must NOT double-send.
			await fireAgentEnd(mock, ctx, "I will now take a concrete first step toward the objective.");
			const before = mock.sentUserMessages.length;

			const heartbeat = intervals.find((i) => i.ms === HEARTBEAT_INTERVAL_MS)!;
		now = startedAt + HEARTBEAT_STALL_MS + 1_000;
			heartbeat.fn();

			expect(mock.sentUserMessages.length).toBe(before); // no extra continuation
		} finally {
			if (mock && ctx) await shutdown(mock, ctx);
			globalThis.setInterval = realSetInterval;
			globalThis.clearInterval = realClearInterval;
			Date.now = realDateNow;
		}
	});

	test("3 consecutive no-tool turns pause the goal via the nudge cap", async () => {
		const { mock, ctx, notifications } = await bootstrap();
		try {
			// Three turns with NO tool call. Each narration is distinct (and well
		// under the degenerate-length threshold) so the repetition classifier does
		// not trip; the pause comes from the nudge cap, not the stuck path.
			await fireAgentEnd(mock, ctx, "I am thinking about the first step of the approach carefully.");
			expect(goalState.nudgeCount).toBe(1);
			await fireAgentEnd(mock, ctx, "Now I am weighing the second option and its trade-offs in detail.");
			expect(goalState.nudgeCount).toBe(2);
			await fireAgentEnd(mock, ctx, "Finally I am considering a third angle before doing anything concrete.");

			expect(goalState.nudgeCount).toBe(3);
			expect(goalState.activeGoal?.status).toBe("paused");
			expect(notifications.some((n) => /nudge cap/.test(n.message))).toBe(true);
		} finally {
			await shutdown(mock, ctx);
		}
	});

	test("a tool-bearing turn resets the nudge count", async () => {
		const { mock, ctx } = await bootstrap();
		try {
			// Two narration-only turns, then a tool-bearing turn must zero the count.
			await fireAgentEnd(mock, ctx, "Pondering the design before I touch any files here.");
			expect(goalState.nudgeCount).toBe(1);
			await fireAgentEnd(mock, ctx, "Still reasoning through edge cases for this approach.");
			expect(goalState.nudgeCount).toBe(2);

			await fireToolEnd(mock, "bash", { stdout: "unique tool output resets the streak" });
			await fireAgentEnd(mock, ctx, "I ran a probe and confirmed the next concrete step to take.");

			expect(goalState.nudgeCount).toBe(0);
			expect(goalState.activeGoal?.status).toBe("active");
		} finally {
			await shutdown(mock, ctx);
		}
	});
});


describe("agent_end length-continue wiring", () => {
	test("a truncated turn re-triggers with LENGTH_CONTINUE_TEXT and skips bookkeeping", async () => {
		const { mock, ctx, notifications } = await bootstrap();
		try {
			// bootstrap() seeds the goal prompt (msg #1 via startGoal); drop it so the
			// toEqual below asserts ONLY the length-continue send (mirrors test 6).
			mock.sentUserMessages.length = 0;
			const before = goalState.activeGoal?.iteration ?? 0;
			await fireAgentEndLength(mock, ctx);
			// fired the continue message exactly once, with followUp delivery
			expect(mock.sentUserMessages).toEqual([{ text: LENGTH_CONTINUE_TEXT, options: { deliverAs: "followUp" } }]);
			// fire-path notify present (consecutive/MAX)
			expect(notifications.some((n) => /auto-continuing \(1\/3\)/.test(n.message))).toBe(true);
			// ledger entry recorded
			expect(mock.entries.some((e) => e.customType === "length_continue_sent" && (e.data as { consecutive: number }).consecutive === 1)).toBe(true);
			// bookkeeping skipped: incrementGoal did NOT run (iteration unchanged)
			expect(goalState.activeGoal?.iteration).toBe(before);
		} finally {
			await shutdown(mock, ctx);
		}
	});

	test("works with NO active goal (plain session truncates too)", async () => {
		__resetGoalState();
		resetLengthContinue();
		const mock = createMockPi();
		goal(mock.pi, createMockOverlay().impl);
		const { ctx } = createMockCtx();
		await (mock.events.get("session_start")?.[0] as ((e: unknown, c: unknown) => void) | undefined)?.({}, ctx);
		try {
			expect(goalState.activeGoal).toBeUndefined();
			await fireAgentEndLength(mock, ctx);
			expect(mock.sentUserMessages).toEqual([{ text: LENGTH_CONTINUE_TEXT, options: { deliverAs: "followUp" } }]);
		} finally {
			for (const h of mock.events.get("session_shutdown") ?? []) await (h as (e: unknown, c: unknown) => void)({}, ctx);
			__resetGoalState();
		}
	});

	test("a non-length turn does NOT send the continue message", async () => {
		const { mock, ctx } = await bootstrap();
		try {
			await fireAgentEnd(mock, ctx, "normal turn text"); // stopReason "stop"
			expect(mock.sentUserMessages.some((m) => m.text === LENGTH_CONTINUE_TEXT)).toBe(false);
		} finally {
			await shutdown(mock, ctx);
		}
	});

	test("pending messages suppress the send (a queued message triggers a turn anyway)", async () => {
		__resetGoalState();
		resetLengthContinue();
		const mock = createMockPi();
		goal(mock.pi, createMockOverlay().impl);
		const { ctx } = createMockCtx({ hasPendingMessages: () => true });
		await (mock.events.get("session_start")?.[0] as ((e: unknown, c: unknown) => void) | undefined)?.({}, ctx);
		try {
			await fireAgentEndLength(mock, ctx);
			expect(mock.sentUserMessages).toEqual([]);
		} finally {
			for (const h of mock.events.get("session_shutdown") ?? []) await (h as (e: unknown, c: unknown) => void)({}, ctx);
			__resetGoalState();
		}
	});

	test("after MAX+1 consecutive truncations it gives up once and stops firing", async () => {
		const { mock, ctx, notifications } = await bootstrap();
		try {
			await fireAgentEndLength(mock, ctx); // 1 fire
			await fireAgentEndLength(mock, ctx); // 2 fire
			await fireAgentEndLength(mock, ctx); // 3 fire
			mock.sentUserMessages.length = 0;
			await fireAgentEndLength(mock, ctx); // 4 > MAX → giveUp, no fire
			expect(mock.sentUserMessages).toEqual([]);
			expect(notifications.some((n) => /stepping aside from auto-continue/.test(n.message))).toBe(true);
			await fireAgentEndLength(mock, ctx); // 5 — still suppressed, no second give-up
			expect(notifications.filter((n) => /stepping aside from auto-continue/.test(n.message)).length).toBe(1);
		} finally {
			await shutdown(mock, ctx);
		}
	});

	test("session_start resets the singleton streak (a later truncate fires again)", async () => {
		const { mock, ctx } = await bootstrap();
		try {
			await fireAgentEndLength(mock, ctx); // streak 1
			await (mock.events.get("session_start")?.[0] as ((e: unknown, c: unknown) => void) | undefined)?.({}, ctx);
			mock.sentUserMessages.length = 0;
			await fireAgentEndLength(mock, ctx); // streak reset → fires again
			expect(mock.sentUserMessages).toEqual([{ text: LENGTH_CONTINUE_TEXT, options: { deliverAs: "followUp" } }]);
		} finally {
			await shutdown(mock, ctx);
		}
	});
});

// ─── Task 5: Reviewer wiring on clean complete ───────────────────────────────
// Asserts the WIRING of runReviewer into goal_complete's clean-complete terminal
// path (the pure cascade is unit-covered in reviewer.test.ts). The harness
// reuses createMockPi/createMockOverlay but links ctx.sessionManager to the
// store the mock pi's appendEntry writes to, so appendReviewerEntry (api write)
// is visible to loadReviewerEntries (sessionManager read) — the refire-window +
// day-cap gates depend on that round-trip. The default createMockPi.appendEntry
// omits the `type:"custom"` discriminator the loaders filter on, so it is
// overridden here to push typed entries. ctx.ui.confirm is faked to record every
// call (title+message) and return a controllable boolean — that is the Confirm
// loop's only seam. cwd is a per-test tmpdir so writeReviewReport never touches
// the repo.

interface ReviewerSession {
	mock: ReturnType<typeof createMockPi>;
	ctx: StatusContext;
	confirms: Array<{ title: string; message: string }>;
	notifies: Array<{ message: string; level?: string }>;
	cleanup: () => void;
}

async function setupReviewerSession(opts: { confirmReturns?: boolean; confirmThrows?: boolean } = {}): Promise<ReviewerSession> {
	__resetGoalState();
	const mock = createMockPi();
	const overlay = createMockOverlay();
	// Shared store: appendEntry writes {type:"custom",customType,data} (the shape
	// loadReviewerEntries/loadGoalStateFromSession filter for), sessionManager
	// reads it back. This closes the api↔sessionManager round-trip the default
	// createMockPi leaves broken (its appendEntry omits `type`).
	const store: Array<{ type: string; customType?: string; data: unknown }> = [];
	(mock.pi as unknown as { appendEntry: (ct: string, d: unknown) => void }).appendEntry = (customType, data) => {
		store.push({ type: "custom", customType, data });
	};
	goal(mock.pi, overlay.impl);

	const confirms: Array<{ title: string; message: string }> = [];
	const notifies: Array<{ message: string; level?: string }> = [];
	const cwd = mkdtempSync(join(tmpdir(), "reviewer-wire-"));
	const ctx = {
		cwd,
		ui: {
			notify: (message: string, level?: string) => { notifies.push({ message, level }); },
			confirm: opts.confirmThrows
				? async (_title: string, _message: string) => { throw new Error("confirm exploded"); }
				: async (title: string, message: string) => {
					confirms.push({ title, message });
					return opts.confirmReturns ?? true;
				},
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => undefined,
		sessionManager: { getBranch: () => store, getEntries: () => store },
	} as unknown as StatusContext;

	const sessionStart = mock.events.get("session_start")?.[0];
	await (sessionStart as ((e: unknown, c: unknown) => void) | undefined)?.({}, ctx);

	return { mock, ctx, confirms, notifies, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

/** Drive a goal_complete call. Ensures an active goal first (a clean/declined
 * complete clears the active goal, so the refire-window test's 2nd call must
 * re-start a bare one or the tool rejects with "no active goal"). */
async function driveComplete(s: ReviewerSession, summary: string) {
	if (!goalState.activeGoal) {
		const goalCmd = s.mock.commands.get("goal");
		await goalCmd?.handler("test objective for reviewer wiring", s.ctx);
	}
	const tool = s.mock.tools[0] as {
		execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; terminate?: boolean }>;
	};
	return tool.execute("reviewer-call", { summary }, new AbortController().signal, () => undefined, s.ctx);
}

/** Pause the active goal via /goal pause — a pause END never reaches the
 * clean-complete terminal path, so the Reviewer must not fire. */
async function driveToPause(s: ReviewerSession) {
	if (!goalState.activeGoal) {
		const goalCmd = s.mock.commands.get("goal");
		await goalCmd?.handler("test objective for reviewer wiring", s.ctx);
	}
	const goalCmd = s.mock.commands.get("goal");
	await goalCmd?.handler("pause", s.ctx);
}

describe("reviewer wiring on clean complete (Task 5)", () => {
	test("bug-shaped summary enqueues a /list item, no Confirm", async () => {
		const s = await setupReviewerSession({ confirmReturns: true });
		try {
			await driveComplete(s, "Done. - TODO: still leaks on big inputs");
			const texts = goalState.list.map((i) => i.text);
			expect(texts.some((t) => t.includes("TODO: still leaks on big inputs"))).toBe(true);
			expect(s.confirms).toHaveLength(0); // bug -> convert-findings-to-list, no Confirm
		} finally {
			s.cleanup();
			__resetGoalState();
		}
	});

	test("architectural summary records a proposal; accept -> createGoal + terminate:false", async () => {
		const s = await setupReviewerSession({ confirmReturns: true });
		try {
			const res = await driveComplete(s, "Done. - we should rewrite the auth layer");
			expect(s.confirms.length).toBeGreaterThanOrEqual(1);
			expect(goalState.activeGoal?.text).toContain("rewrite the auth layer");
			expect(res.terminate).toBe(false);
		} finally {
			s.cleanup();
			__resetGoalState();
		}
	});

	test("architectural summary declined -> terminate:true, goal cleared", async () => {
		const s = await setupReviewerSession({ confirmReturns: false });
		try {
			const res = await driveComplete(s, "Done. - we should rewrite the auth layer");
			expect(res.terminate).toBe(true);
			expect(goalState.activeGoal).toBeUndefined();
		} finally {
			s.cleanup();
			__resetGoalState();
		}
	});

	test("clean summary -> regression-scan proposal Confirm", async () => {
		const s = await setupReviewerSession({ confirmReturns: true });
		try {
			await driveComplete(s, "Everything is done and verified. Nothing left.");
			expect(goalState.activeGoal?.text).toContain("regression scan");
		} finally {
			s.cleanup();
			__resetGoalState();
		}
	});

	test("paused goal never fires the reviewer", async () => {
		const s = await setupReviewerSession({ confirmReturns: true });
		try {
			await driveToPause(s);
			expect(goalState.activeGoal?.status).toBe("paused");
			expect(s.confirms).toHaveLength(0);
		} finally {
			s.cleanup();
			__resetGoalState();
		}
	});

	test("refire window: a second clean complete within 5 min is suppressed", async () => {
		const s = await setupReviewerSession({ confirmReturns: true });
		try {
			await driveComplete(s, "Done. - TODO: a"); // fires + records reviewer_fired
			const firstConfirms = s.confirms.length;
			await driveComplete(s, "Done. - TODO: b"); // would normally re-fire
			expect(s.confirms.length).toBe(firstConfirms); // suppressed
		} finally {
			s.cleanup();
			__resetGoalState();
		}
	});

	test("bare /goal with clean summary + decline -> byte-identical completion (regression)", async () => {
		const s = await setupReviewerSession({ confirmReturns: false });
		try {
			const res = await driveComplete(s, "All done, verified, nothing left.");
			expect(res.terminate).toBe(true);
			// The user-facing completion text is unchanged from the pre-Reviewer path.
			expect(res.content[0]!.text).toContain("Goal complete");
		} finally {
			s.cleanup();
			__resetGoalState();
		}
	});

	test("a throwing dep does not block completion (try/catch)", async () => {
		const s = await setupReviewerSession({ confirmThrows: true });
		try {
			const res = await driveComplete(s, "Done. - we should rewrite everything");
			expect(res.terminate).toBe(true); // still completes
			expect(s.notifies.some((n) => /Reviewer skipped/i.test(n.message))).toBe(true);
		} finally {
			s.cleanup();
			__resetGoalState();
		}
	});
});
