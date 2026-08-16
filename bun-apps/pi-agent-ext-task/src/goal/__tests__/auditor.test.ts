import { describe, expect, test } from "bun:test";
import { runGoalCompletionAuditor, AUDIT_MAX_RETRIES, AUDIT_HISTORY_CAP, AUDITOR_STALL_MS } from "../auditor.js";
import type { ActiveGoal } from "../format.js";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

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
	test("ModelRuntime unavailable (missing runtime field) → returns clear error, no crash", async () => {
		// Simulate a pi version that renamed the 'runtime' field.
		// The auditor should return a clear error, not crash with a vague failure.
		const r = await runGoalCompletionAuditor({
			ctx: { cwd: "/repo", model: "m", modelRegistry: {} } as any, // No 'runtime' field
			goal: makeGoal(),
		});
		expect(r.approved).toBe(false);
		expect(r.disapproved).toBe(false);
		expect(r.output).toBe("");
		expect(r.error).toBe("ModelRegistry.runtime unavailable on this pi version — completion auditor disabled");
	});
	test("ModelRuntime unavailable (null modelRegistry) → returns clear error, no crash", async () => {
		const r = await runGoalCompletionAuditor({
			ctx: { cwd: "/repo", model: "m", modelRegistry: null } as any,
			goal: makeGoal(),
		});
		expect(r.approved).toBe(false);
		expect(r.disapproved).toBe(false);
		expect(r.output).toBe("");
		expect(r.error).toBe("ModelRegistry.runtime unavailable on this pi version — completion auditor disabled");
	});
	test("ModelRuntime present → auditor runs normally (happy path unchanged)", async () => {
		// Verify that when runtime is available, behavior is unchanged from before.
		const r = await runGoalCompletionAuditor({
			ctx: { cwd: "/repo", model: "anthropic/claude-sonnet-4", modelRegistry: { runtime: {} } } as any,
			goal: makeGoal(),
			completionSummary: "done",
			sessionFactory: async () => ({ session: fakeSession({ output: "looks good\n<approved/>", toolCalls: ["read"] }) } as any),
		});
		expect(r.approved).toBe(true);
		expect(r.error).toBeUndefined();
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

describe("contract: ModelRegistry.runtime field (guard against silent pi rename)", () => {
	/** Minimal ModelRuntime stub that no-ops all method calls.
	 *  ModelRegistry's constructor stores the runtime without calling methods,
	 *  so a Proxy is sufficient for the contract test. If pi changes the
	 *  constructor to invoke runtime methods, this stub will need expansion. */
	function createStubRuntime(): ModelRuntime {
		return new Proxy({} as unknown as ModelRuntime, {
			get(_target, prop) {
				// Return no-op functions for method calls, empty objects for getters
				if (typeof prop === "string" && prop !== "constructor" && prop !== "prototype") {
					return () => ({});
				}
				return undefined;
			},
		});
	}

	test("contract: ModelRegistry still exposes the 'runtime' field the auditor casts to (guard against silent pi rename)", () => {
		// Create a real ModelRegistry from the pi package with a minimal stub runtime.
		// If pi's constructor ever calls methods on the runtime at construction time,
		// the stub Proxy will handle it (no-ops all calls). If pi renames the
		// 'runtime' field, the cast below yields undefined and the test fails.
		const stubRuntime = createStubRuntime();
		const registry = new ModelRegistry(stubRuntime);

		// This is the SAME cast the auditor uses (via extractModelRuntime).
		// If pi renamed 'runtime' to something else, this becomes undefined.
		const extractedRuntime = (registry as unknown as { runtime: ModelRuntime }).runtime;

		// Identity check: the extracted runtime MUST be the same instance we passed in.
		// A rename would make this undefined and the assertion fails.
		expect(extractedRuntime).toBe(stubRuntime);
	});
});
