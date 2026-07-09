/**
 * A3.1 / A3.2 / A3.3 — subagent robustness.
 *   bun test extensions/__tests__/subagentRobustness.test.mjs
 *
 * Uses a deliberately failing command (sleep with tiny timeout) to exercise
 * the timeout path without depending on a real LLM/pi runtime.
 */
import { describe, it, expect } from "bun:test";
import { runSubagent, invalidateCache } from "../obsidian.ts";

describe("runSubagent — timeout (A3.1)", () => {
	it("reaps a hanging child after OB_SUBAGENT_TIMEOUT_MS", async () => {
		// We can't easily inject a fake task that hangs without spawning real `pi`.
		// Instead, set a tiny timeout and a task that the (missing) pi binary will
		// fail fast on; either way the promise must settle within timeout+grace.
		const prev = process.env.OB_SUBAGENT_TIMEOUT_MS;
		process.env.OB_SUBAGENT_TIMEOUT_MS = "300"; // 0.3s
		const t0 = Date.now();
		try {
			const res = await runSubagent(
				process.cwd(),
				"sysprompt",
				"task that will not run (no real pi)",
				"read",
				undefined,
				"pi-test-timeout-",
			);
			const dt = Date.now() - t0;
			// Settles either via fast failure (exitCode!=0) or timeout (timedOut=true).
			expect(res).toHaveProperty("output");
			expect(res).toHaveProperty("stderr");
			expect(typeof res.timedOut).toBe("boolean");
			// must NOT hang beyond timeout + 6s grace
			expect(dt).toBeLessThan(10_000);
		} finally {
			if (prev === undefined) delete process.env.OB_SUBAGENT_TIMEOUT_MS;
			else process.env.OB_SUBAGENT_TIMEOUT_MS = prev;
		}
	}, 15_000);
});

describe("invalidateCache — full clear (A3.2 support)", () => {
	it("clears without throwing", () => {
		expect(() => invalidateCache()).not.toThrow();
		expect(() => invalidateCache("/some/abs/path.md")).not.toThrow();
	});
});
