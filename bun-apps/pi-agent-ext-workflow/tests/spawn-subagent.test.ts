import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { spawnSubagent } from "../src/spawn-subagent.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";

/** Minimal injectable runner (Pick<WorkflowAgent, "run">) that records calls. */
function mkRunner(
	impl: (p: { prompt: string; opts: Record<string, unknown> }) => Promise<unknown>,
) {
	const calls: Array<{ prompt: string; opts: Record<string, unknown> }> = [];
	return {
		calls,
		run: async (prompt: string, opts: Record<string, unknown>) => {
			calls.push({ prompt, opts });
			return impl({ prompt, opts });
		},
	};
}

describe("spawnSubagent", () => {
	it("success → {output, exitCode:0, stderr:'', timedOut:false}", async () => {
		const runner = mkRunner(async () => "RESULT");
		const out = await spawnSubagent({ task: "do it", tools: ["read"], agent: runner });
		assert.deepEqual(out, { output: "RESULT", exitCode: 0, stderr: "", timedOut: false });
	});

	it("passes tools/excludeTools/model/cwd/instructions through to runner.run", async () => {
		const runner = mkRunner(async () => "ok");
		await spawnSubagent({
			task: "t",
			tools: ["a", "b"],
			excludeTools: ["c"],
			model: "openai/gpt-5",
			cwd: "/x",
			instructions: "be brief",
			agent: runner,
		});
		assert.deepEqual(runner.calls[0]?.opts.toolNames, ["a", "b"]);
		assert.deepEqual(runner.calls[0]?.opts.disallowedToolNames, ["c"]);
		assert.equal(runner.calls[0]?.opts.model, "openai/gpt-5");
		assert.equal(runner.calls[0]?.opts.cwd, "/x");
		assert.equal(runner.calls[0]?.opts.instructions, "be brief");
		assert.equal(runner.calls[0]?.prompt, "t");
	});

	it("timeout (AGENT_TIMEOUT) → timedOut:true, retried once when retryOnTransient:true", async () => {
		let n = 0;
		const runner = mkRunner(async () => {
			n++;
			throw new WorkflowError("agent timed out", WorkflowErrorCode.AGENT_TIMEOUT, { recoverable: true });
		});
		const out = await spawnSubagent({ task: "t", retryOnTransient: true, agent: runner });
		assert.equal(n, 2, "retried once after a transient timeout");
		assert.equal(out.timedOut, true);
		assert.notEqual(out.exitCode, 0);
		assert.equal(out.output, "");
	});

	it("retryOnTransient:false → no retry on timeout", async () => {
		let n = 0;
		const runner = mkRunner(async () => {
			n++;
			throw new WorkflowError("agent timed out", WorkflowErrorCode.AGENT_TIMEOUT, { recoverable: true });
		});
		const out = await spawnSubagent({ task: "t", retryOnTransient: false, agent: runner });
		assert.equal(n, 1);
		assert.equal(out.timedOut, true);
	});

	it("non-transient throw → {output:'', exitCode:1, stderr}, no retry", async () => {
		let n = 0;
		const runner = mkRunner(async () => {
			n++;
			throw new Error("hard fail");
		});
		const out = await spawnSubagent({ task: "t", retryOnTransient: true, agent: runner });
		assert.equal(n, 1, "non-transient errors are not retried");
		assert.equal(out.output, "");
		assert.equal(out.exitCode, 1);
		assert.match(out.stderr, /hard fail/);
		assert.equal(out.timedOut, false);
	});

	it("transient-then-success → retried, returns the success output", async () => {
		let n = 0;
		const runner = mkRunner(async () => {
			n++;
			if (n === 1) throw new WorkflowError("agent timed out", WorkflowErrorCode.AGENT_TIMEOUT, { recoverable: true });
			return "OK_AFTER_RETRY";
		});
		const out = await spawnSubagent({ task: "t", retryOnTransient: true, agent: runner });
		assert.equal(n, 2);
		assert.equal(out.output, "OK_AFTER_RETRY");
		assert.equal(out.exitCode, 0);
	});

	it("prime is accepted but a no-op (no extra call; output unaffected)", async () => {
		const runner = mkRunner(async () => "out");
		const out = await spawnSubagent({ task: "t", prime: { query: "loRA", topK: 5 }, agent: runner });
		assert.equal(out.output, "out");
		assert.equal(runner.calls.length, 1, "prime did not add a retrieve call (③ owns it)");
	});
});
