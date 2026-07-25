import { describe, expect, test } from "bun:test";
import { runGoalCompletionAuditor, AUDIT_MAX_RETRIES, AUDIT_HISTORY_CAP, AUDITOR_STALL_MS } from "../auditor.js";
import type { ActiveGoal } from "../format.js";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

function makeGoal(overrides: Partial<ActiveGoal> = {}): ActiveGoal {
	return { id: "g1", text: "ship feature X", status: "active", startedAt: 0, updatedAt: 0,
		iteration: 0, tokensUsed: 0, timeUsedSeconds: 0, baselineTokens: 0, ...overrides };
}

/** Build a fake session that emits canned events to subscribers. */
function fakeSession(opts: {
	output?: string;            // assistant text to emit on message_end
	stopReason?: string;        // message_end stopReason (default "stop")
	toolCalls?: string[];       // tool_execution_start/end pairs to emit before message_end
	throwOnPrompt?: string;     // if set, prompt() throws this
}) {
	let sub: ((e: any) => void) | undefined;
	return {
		subscribe: (fn: (e: any) => void) => { sub = fn; return () => { sub = undefined; }; },
		prompt: async () => {
			if (opts.throwOnPrompt) throw new Error(opts.throwOnPrompt);
			const s = sub; if (!s) return;
			for (const name of opts.toolCalls ?? []) {
				s({ type: "tool_execution_start", toolName: name, args: {} });
				s({ type: "tool_execution_end", toolName: name });
			}
			s({ type: "message_end", message: { role: "assistant", stopReason: opts.stopReason ?? "stop",
				content: [{ type: "text", text: opts.output ?? "" }] } });
		},
		abort: () => {},
	};
}

describe("runGoalCompletionAuditor — safety floors", () => {
	test("approved after a read tool → approved=true", async () => {
		const r = await runGoalCompletionAuditor({
			ctx: { cwd: "/repo", model: "anthropic/claude-sonnet-4", modelRegistry: { runtime: {} } } as any,
			goal: makeGoal(),
			completionSummary: "done",
			sessionFactory: async () => ({ session: fakeSession({ output: "looks good\n<approved/>", toolCalls: ["read"] }) } as any),
		});
		expect(r.approved).toBe(true);
		expect(r.error).toBeUndefined();
	});
	test("approved with NO read tool → converted to disapproval", async () => {
		const r = await runGoalCompletionAuditor({
			ctx: { cwd: "/repo", model: "m", modelRegistry: { runtime: {} } } as any,
			goal: makeGoal(),
			sessionFactory: async () => ({ session: fakeSession({ output: "<approved/>" }) } as any),
		});
		expect(r.approved).toBe(false);
		expect(r.disapproved).toBe(true);
		expect(r.error).toContain("read tool");
	});
	test("silent (no output) → error, not a verdict", async () => {
		const r = await runGoalCompletionAuditor({
			ctx: { cwd: "/repo", model: "m", modelRegistry: { runtime: {} } } as any,
			goal: makeGoal(),
			sessionFactory: async () => ({ session: fakeSession({ output: "" }) } as any),
		});
		expect(r.approved).toBe(false);
		expect(r.disapproved).toBe(false);
		expect(r.error).toBeTruthy();
	});
	test("no verdict marker → error, not a verdict", async () => {
		const r = await runGoalCompletionAuditor({
			ctx: { cwd: "/repo", model: "m", modelRegistry: { runtime: {} } } as any,
			goal: makeGoal(),
			sessionFactory: async () => ({ session: fakeSession({ output: "just analysis, no tag", toolCalls: ["read"] }) } as any),
		});
		expect(r.approved).toBe(false);
		expect(r.disapproved).toBe(false);
		expect(r.error).toContain("verdict");
	});
	test("prompt() throws → error, not a verdict", async () => {
		const r = await runGoalCompletionAuditor({
			ctx: { cwd: "/repo", model: "m", modelRegistry: { runtime: {} } } as any,
			goal: makeGoal(),
			sessionFactory: async () => ({ session: fakeSession({ throwOnPrompt: "boom" }) } as any),
		});
		expect(r.approved).toBe(false);
		expect(r.disapproved).toBe(false);
		expect(r.error).toBe("boom");
	});
	test("impossible verdict captures reason", async () => {
		const r = await runGoalCompletionAuditor({
			ctx: { cwd: "/repo", model: "m", modelRegistry: { runtime: {} } } as any,
			goal: makeGoal(),
			sessionFactory: async () => ({ session: fakeSession({ output: "<impossible>contradictory reqs</impossible>", toolCalls: ["read"] }) } as any),
		});
		expect(r.impossible).toBe(true);
		expect(r.impossibleReason).toBe("contradictory reqs");
	});
	test("regression shield: approval without evidence → disapproval + missing items", async () => {
		const r = await runGoalCompletionAuditor({
			ctx: { cwd: "/repo", model: "m", modelRegistry: { runtime: {} } } as any,
			goal: makeGoal({ verificationContract: "tests green\nno crashes" }),
			sessionFactory: async () => ({ session: fakeSession({ output: "<approved/>", toolCalls: ["read"] }) } as any),
		});
		expect(r.approved).toBe(false);
		expect(r.disapproved).toBe(true);
		expect(r.regressionShieldPassed).toBe(false);
		expect(r.regressionShieldMissing?.length).toBe(2);
	});
	test("no model → error (never a silent audit failure)", async () => {
		const r = await runGoalCompletionAuditor({
			ctx: { cwd: "/repo", model: undefined, modelRegistry: { runtime: {} } } as any,
			goal: makeGoal(),
		});
		expect(r.error).toContain("no model");
	});
	test("stall (no activity > AUDITOR_STALL_MS) → abort → error, not a verdict", async () => {
		// The runner hardcodes a 15s watchdog cadence and reads Date.now() to
		// detect inactivity. To exercise the stall branch without waiting 10 real
		// minutes, we (a) force the watchdog interval onto a 1ms cadence and
		// (b) jump Date.now() past the stall window after the first read. All
		// globals are restored in the finally so nothing leaks to other tests.
		const realSetInterval = globalThis.setInterval;
		const realDateNow = Date.now;
		try {
			// Jump the clock past the stall window ONLY once prompt() is entered,
			// so lastEventAt (seeded just before the watchdog starts) stays real
			// while every later Date.now() reads far past it. The runner hardcodes
			// a 15s watchdog cadence; force it to 1ms so the first tick trips the
			// abort in milliseconds, not minutes.
			let jumpTime = false;
			Date.now = (() => realDateNow() + (jumpTime ? AUDITOR_STALL_MS + 1 : 0)) as typeof Date.now;
			globalThis.setInterval = (((fn: () => void) => realSetInterval(fn, 1)) as typeof globalThis.setInterval);

			let aborted = false;
			let resolvePrompt: () => void = () => {};
			const hanging = new Promise<void>((r) => { resolvePrompt = r; });
			const stalledSession = {
				subscribe: () => () => {},
				// Never emit any session event (so lastEventAt stays stale), flip the
			// clock jump on, then resolve prompt shortly after the watchdog fires
				// so the runner proceeds to the stalled-return branch.
				prompt: () => { jumpTime = true; setTimeout(() => resolvePrompt(), 30); return hanging; },
				abort: () => { aborted = true; },
			};
			const r = await runGoalCompletionAuditor({
				ctx: { cwd: "/repo", model: "m", modelRegistry: { runtime: {} } } as any,
				goal: makeGoal(),
				sessionFactory: async () => ({ session: stalledSession } as any),
			});
			expect(r.approved).toBe(false);
			expect(r.disapproved).toBe(false);
			expect(r.error).toMatch(/stalled/i);
			expect(r.error).toContain("Infrastructure failure");
			expect(aborted).toBe(true);
		} finally {
			globalThis.setInterval = realSetInterval;
			Date.now = realDateNow;
		}
	});
	test("constants exported", () => {
		expect(AUDIT_MAX_RETRIES).toBe(3);
		expect(AUDIT_HISTORY_CAP).toBe(8);
	});
});
