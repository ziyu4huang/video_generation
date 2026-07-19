import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { spawnSubagent } from "../src/spawn-subagent.js";

/** Minimal injectable runner (Pick<WorkflowAgent, "run">) that records calls. */
function mkRunner(impl: (p: { prompt: string; opts: Record<string, unknown> }) => Promise<unknown>) {
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
    assert.deepEqual(out, { output: "RESULT", exitCode: 0, stderr: "", timedOut: false, usage: undefined });
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

  // D8-1: when opts.schema is set, WorkflowAgent.run returns a validated OBJECT.
  // The adapter MUST preserve it as JSON — `String(obj)` would yield "[object Object]"
  // and silently destroy the schema payload (returned as a success-shaped result).
  it("schema object result is JSON-serialized, not String()'d to [object Object]", async () => {
    const runner = mkRunner(async () => ({ ok: true }));
    const out = await spawnSubagent({
      task: "t",
      schema: { type: "object", properties: { ok: { type: "boolean" } } } as never,
      agent: runner,
    });
    assert.equal(out.exitCode, 0);
    assert.equal(out.output, '{"ok":true}', "schema payload preserved as JSON, NOT [object Object]");
  });

  it("null result (recoverable exhaustion) → empty string output, not 'null' or [object Object]", async () => {
    const runner = mkRunner(async () => null);
    const out = await spawnSubagent({ task: "t", agent: runner });
    assert.equal(out.exitCode, 0);
    assert.equal(out.output, "", "null result serializes to empty string");
  });

  it("externalSignal already aborted before the call → the internal signal passed to runner.run is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = mkRunner(async (p) => {
      assert.equal((p.opts.signal as AbortSignal).aborted, true, "internal signal should already be aborted");
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    const out = await spawnSubagent({ task: "t", externalSignal: controller.signal, agent: runner });
    assert.equal(out.timedOut, true);
    assert.equal(out.exitCode, 124);
  });

  it("externalSignal that aborts mid-run propagates to the internal signal (addEventListener path)", async () => {
    const controller = new AbortController();
    const runner = mkRunner(async (p) => {
      const sig = p.opts.signal as AbortSignal;
      assert.equal(sig.aborted, false, "not aborted yet at call time");
      controller.abort();
      await Promise.resolve();
      assert.equal(sig.aborted, true, "external abort propagated to the internal signal");
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    const out = await spawnSubagent({ task: "t", externalSignal: controller.signal, agent: runner });
    assert.equal(out.timedOut, true);
  });

  it("REGRESSION: an external abort must not trigger the transient-failure retry", async () => {
    const controller = new AbortController();
    controller.abort();
    let n = 0;
    const runner = mkRunner(async () => {
      n++;
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    const out = await spawnSubagent({
      task: "t",
      externalSignal: controller.signal,
      retryOnTransient: true,
      agent: runner,
    });
    assert.equal(n, 1, "external abort must not cause a retry — that would re-run work the user just cancelled");
    assert.equal(out.timedOut, true);
  });

  it("onUsage fires → result.usage carries the reported AgentUsage", async () => {
    const fixtureUsage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150, cost: 0.002 };
    const runner = mkRunner(async (p) => {
      (p.opts.onUsage as ((u: typeof fixtureUsage) => void) | undefined)?.(fixtureUsage);
      return "ok";
    });
    const out = await spawnSubagent({ task: "t", agent: runner });
    assert.deepEqual(out.usage, fixtureUsage);
  });

  it("usage is undefined when the runner never calls onUsage", async () => {
    const runner = mkRunner(async () => "ok");
    const out = await spawnSubagent({ task: "t", agent: runner });
    assert.equal(out.usage, undefined);
  });

  it("usage is preserved on a failure path too (onUsage fires before the throw propagates)", async () => {
    const fixtureUsage = { input: 20, output: 0, cacheRead: 0, cacheWrite: 0, total: 20, cost: 0.0001 };
    const runner = mkRunner(async (p) => {
      (p.opts.onUsage as ((u: typeof fixtureUsage) => void) | undefined)?.(fixtureUsage);
      throw new Error("hard fail");
    });
    const out = await spawnSubagent({ task: "t", retryOnTransient: false, agent: runner });
    assert.deepEqual(out.usage, fixtureUsage);
    assert.equal(out.exitCode, 1);
  });

  // REGRESSION (2026-07 review): the REAL WorkflowAgent.run abort paths throw a
  // plain `Error("Subagent was aborted")` — name "Error", NOT a DOMException
  // named AbortError like the mocks above. A timeoutMs-triggered abort was
  // classified as a generic failure (exitCode 1, timedOut:false, no retry).
  it("timeoutMs abort with a runner-shaped Error('Subagent was aborted') → timedOut:true, 124, retried", async () => {
    let n = 0;
    const runner = mkRunner(async (p) => {
      n++;
      const sig = p.opts.signal as AbortSignal;
      await new Promise<void>((resolve) => {
        if (sig.aborted) resolve();
        else sig.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("Subagent was aborted");
    });
    const out = await spawnSubagent({ task: "t", timeoutMs: 20, retryOnTransient: true, agent: runner });
    assert.equal(n, 2, "a timeout is transient and must be retried once");
    assert.equal(out.timedOut, true, "signal-driven abort must classify as a timeout");
    assert.equal(out.exitCode, 124);
  });

  // REGRESSION (2026-07 review): usage was a tryOnce-local — a transient first
  // attempt's tokens (largest exactly when it timed out) vanished on retry.
  it("usage is summed across a transient failure + retry, not just the second attempt's", async () => {
    let n = 0;
    const runner = mkRunner(async (p) => {
      n++;
      const onUsage = p.opts.onUsage as ((u: Record<string, number>) => void) | undefined;
      if (n === 1) {
        onUsage?.({ input: 100, output: 40, cacheRead: 10, cacheWrite: 5, total: 140, cost: 0.01 });
        throw new WorkflowError("agent timed out", WorkflowErrorCode.AGENT_TIMEOUT, { recoverable: true });
      }
      onUsage?.({ input: 200, output: 60, cacheRead: 20, cacheWrite: 5, total: 260, cost: 0.02 });
      return "ok";
    });
    const out = await spawnSubagent({ task: "t", retryOnTransient: true, agent: runner });
    assert.equal(n, 2);
    assert.deepEqual(out.usage, { input: 300, output: 100, cacheRead: 30, cacheWrite: 10, total: 400, cost: 0.03 });
  });

  it("onHistory is forwarded to runner.run and fires with what the runner reports", async () => {
    const fixtureHistory = [{ role: "assistant" as const, kind: "toolCall" as const, toolName: "read", text: "{}" }];
    const seen: unknown[] = [];
    const runner = mkRunner(async (p) => {
      (p.opts.onHistory as ((h: typeof fixtureHistory) => void) | undefined)?.(fixtureHistory);
      return "ok";
    });
    await spawnSubagent({
      task: "t",
      agent: runner,
      onHistory: (h) => seen.push(h),
    });
    assert.deepEqual(seen, [fixtureHistory]);
  });
});
