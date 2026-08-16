import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentUsage, saveModelTierConfig, WorkflowError, WorkflowErrorCode } from "@repo/pi-agent-core-runtime";
import { deriveTaskLabel, resolveSessionOverride, spawnSubagent } from "../src/spawn-subagent.js";

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
  it("success → {output} with no failure", async () => {
    const runner = mkRunner(async () => "RESULT");
    const out = await spawnSubagent({ task: "do it", tools: ["read"], agent: runner });
    assert.deepEqual(out, { output: "RESULT", usage: undefined });
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

  it("mainModel is the default effective model when model+tier are omitted (default = current LLM)", async () => {
    const runner = mkRunner(async () => "ok");
    await spawnSubagent({ task: "t", mainModel: "deepseek/deepseek-v4-flash", agent: runner });
    assert.equal(
      runner.calls[0]?.opts.model,
      "deepseek/deepseek-v4-flash",
      "omit → live session model, not stale medium tier",
    );
    assert.equal(runner.calls[0]?.opts.tier, undefined);
  });

  it("tier set + model omitted → tier forwarded, effectiveModel NOT defaulted to mainModel", async () => {
    const runner = mkRunner(async () => "ok");
    await spawnSubagent({ task: "t", tier: "small", mainModel: "deepseek/deepseek-v4-flash", agent: runner });
    assert.equal(runner.calls[0]?.opts.model, undefined, "tier path: model stays undefined for resolveAgentModelSpec");
    assert.equal(runner.calls[0]?.opts.tier, "small");
  });

  it("capability resolves to the configured model-spec", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-cap-"));
    const homeBackup = process.env.HOME;
    process.env.HOME = dir;
    saveModelTierConfig({ tiers: { small: "openai/x" }, capabilities: { vision: "lmstudio/qwen-vl" } });
    try {
      const runner = mkRunner(async () => "ok");
      await spawnSubagent({ task: "describe the image", capability: "vision", agent: runner });
      assert.equal(runner.calls[0]?.opts.model, "lmstudio/qwen-vl");
    } finally {
      process.env.HOME = homeBackup;
    }
  });

  it("explicit model wins over capability", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-cap-"));
    const homeBackup = process.env.HOME;
    process.env.HOME = dir;
    saveModelTierConfig({ tiers: { small: "openai/x" }, capabilities: { vision: "lmstudio/qwen-vl" } });
    try {
      const runner = mkRunner(async () => "ok");
      await spawnSubagent({ task: "t", model: "openai/explicit", capability: "vision", agent: runner });
      assert.equal(runner.calls[0]?.opts.model, "openai/explicit");
    } finally {
      process.env.HOME = homeBackup;
    }
  });

  it("explicit model wins over mainModel", async () => {
    const runner = mkRunner(async () => "ok");
    await spawnSubagent({ task: "t", model: "openai/gpt-5", mainModel: "deepseek/deepseek-v4-flash", agent: runner });
    assert.equal(runner.calls[0]?.opts.model, "openai/gpt-5");
  });

  it("forwards tier/onModelResolved/onModelFallback to runner.run", async () => {
    const runner = mkRunner(async ({ opts }) => {
      opts.onModelResolved?.("deepseek/deepseek-v4-flash");
      return "ok";
    });
    let resolved = "";
    let fallback = "";
    await spawnSubagent({
      task: "t",
      tier: "big",
      onModelResolved: (id) => {
        resolved = id;
      },
      onModelFallback: (spec) => {
        fallback = spec;
      },
      agent: runner,
    });
    assert.equal(runner.calls[0]?.opts.tier, "big");
    assert.equal(resolved, "deepseek/deepseek-v4-flash", "onModelResolved forwarded + fires");
    assert.equal(typeof runner.calls[0]?.opts.onModelFallback, "function", "onModelFallback forwarded");
    assert.equal(fallback, "", "runner did not trigger fallback here");
  });

  it("forwards onUsage to the caller (fires once at run end) alongside the internal result.usage capture", async () => {
    const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30, cost: 0.012 };
    const runner = mkRunner(async ({ opts }) => {
      opts.onUsage?.(usage);
      return "ok";
    });
    const seen: AgentUsage[] = [];
    const res = await spawnSubagent({ task: "t", agent: runner, onUsage: (u) => seen.push(u) });
    assert.equal(seen.length, 1, "opts.onUsage fires exactly once");
    assert.deepEqual(seen[0], usage, "the caller receives the usage payload verbatim");
    assert.deepEqual(res.usage, usage, "the internal result.usage capture still works (not removed)");
  });

  it("onUsage is optional — omitting it changes nothing (result.usage still captured)", async () => {
    const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 5, cost: 0.001 };
    const runner = mkRunner(async ({ opts }) => {
      opts.onUsage?.(usage);
      return "ok";
    });
    const res = await spawnSubagent({ task: "t", agent: runner });
    assert.deepEqual(res.usage, usage, "result.usage captured even with no caller onUsage");
  });

  it("timeout (AGENT_TIMEOUT) → failure.kind timedout, retried once when retryOnTransient:true", async () => {
    let n = 0;
    const runner = mkRunner(async () => {
      n++;
      throw new WorkflowError("agent timed out", WorkflowErrorCode.AGENT_TIMEOUT, { recoverable: true });
    });
    const out = await spawnSubagent({ task: "t", retryOnTransient: true, agent: runner });
    assert.equal(n, 2, "retried once after a transient timeout");
    assert.equal(out.failure?.kind, "timedout");
    assert.ok(out.failure, "a timeout is a failure");
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
    assert.equal(out.failure?.kind, "timedout");
  });

  it("non-transient throw → failure.kind failed with the message, no retry", async () => {
    let n = 0;
    const runner = mkRunner(async () => {
      n++;
      throw new Error("hard fail");
    });
    const out = await spawnSubagent({ task: "t", retryOnTransient: true, agent: runner });
    assert.equal(n, 1, "non-transient errors are not retried");
    assert.equal(out.output, "");
    assert.equal(out.failure?.kind, "failed");
    assert.match(out.failure?.message ?? "", /hard fail/);
    assert.notEqual(out.failure?.kind, "timedout");
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
    assert.equal(out.failure, undefined);
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
    assert.equal(out.failure, undefined);
    assert.equal(out.output, '{"ok":true}', "schema payload preserved as JSON, NOT [object Object]");
  });

  it("null result (recoverable exhaustion) → empty string output, not 'null' or [object Object]", async () => {
    const runner = mkRunner(async () => null);
    const out = await spawnSubagent({ task: "t", agent: runner });
    assert.equal(out.failure, undefined);
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
    assert.equal(out.failure?.kind, "timedout");
    assert.equal(out.failure?.kind, "timedout");
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
    assert.equal(out.failure?.kind, "timedout");
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
    assert.equal(out.failure?.kind, "timedout");
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
    assert.equal(out.failure?.kind, "failed");
  });

  // REGRESSION (2026-07 review): the REAL WorkflowAgent.run abort paths throw a
  // plain `Error("Subagent was aborted")` — name "Error", NOT a DOMException
  // named AbortError like the mocks above. A timeoutMs-triggered abort was
  // classified as a generic failure (kind "failed", no retry).
  it("timeoutMs abort with a runner-shaped Error('Subagent was aborted') → kind timedout, retried", async () => {
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
    assert.equal(out.failure?.kind, "timedout", "signal-driven abort must classify as a timeout");
    assert.equal(out.failure?.kind, "timedout");
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

describe("spawnSubagent budget", () => {
  it("TOKEN_BUDGET_EXHAUSTED → failure.kind budget, non-transient (not retried)", async () => {
    const runner = mkRunner(async () => {
      throw new WorkflowError(
        "subagent tokens budget exhausted (1234 tokens > limit 1000)",
        WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
        { recoverable: false, details: { kind: "tokens", limit: 1000, actual: 1234 } },
      );
    });
    const out = await spawnSubagent({ task: "t", tokenBudget: 1000, agent: runner });
    assert.equal(out.failure?.kind, "budget");
    assert.deepEqual(out.failure?.kind === "budget" ? out.failure.budget : undefined, {
      kind: "tokens",
      limit: 1000,
      actual: 1234,
    });
    assert.match(out.failure?.message ?? "", /budget exhausted/);
    assert.equal(runner.calls.length, 1, "budget exhaustion is non-transient → not retried");
  });

  it("forwards tokenBudget/spendBudget to runner.run", async () => {
    const runner = mkRunner(async () => "ok");
    await spawnSubagent({ task: "t", tokenBudget: 5000, spendBudget: 0.25, agent: runner });
    assert.equal(runner.calls[0]?.opts.tokenBudget, 5000);
    assert.equal(runner.calls[0]?.opts.spendBudget, 0.25);
  });

  it("budget exhaustion with retryOnTransient:true still does NOT retry", async () => {
    const runner = mkRunner(async () => {
      throw new WorkflowError("spend budget exhausted", WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED, {
        recoverable: false,
        details: { kind: "spend", limit: 0.5, actual: 0.62 },
      });
    });
    const out = await spawnSubagent({ task: "t", spendBudget: 0.5, retryOnTransient: true, agent: runner });
    assert.equal(out.failure?.kind === "budget" ? out.failure.budget.kind : undefined, "spend");
    assert.equal(runner.calls.length, 1, "never retry a budget exhaustion even with retryOnTransient");
  });
});

describe("spawnSubagent budget warning (80%, informational)", () => {
  const mkUsage = (total: number, cost: number) => ({
    input: Math.round(total * 0.8),
    output: Math.round(total * 0.2),
    cacheRead: 0,
    cacheWrite: 0,
    total,
    cost,
  });

  it("final usage at exactly 80% of tokenBudget → budgetWarning attached, run still succeeds", async () => {
    const runner = mkRunner(async (p) => {
      (p.opts.onUsage as ((u: ReturnType<typeof mkUsage>) => void) | undefined)?.(mkUsage(800, 0.01));
      return "ok";
    });
    const out = await spawnSubagent({ task: "t", tokenBudget: 1000, agent: runner });
    assert.deepEqual(out.budgetWarning, { kind: "tokens", limit: 1000, actual: 800 });
    assert.equal(out.failure, undefined, "warning alone never aborts — the run completes");
    assert.notEqual(out.failure?.kind, "budget", "warning is NOT an exhaustion record");
    assert.equal(runner.calls.length, 1, "warning alone never triggers a retry");
  });

  it("final usage above 80% but under the limit → budgetWarning attached", async () => {
    const runner = mkRunner(async (p) => {
      (p.opts.onUsage as ((u: ReturnType<typeof mkUsage>) => void) | undefined)?.(mkUsage(950, 0.01));
      return "ok";
    });
    const out = await spawnSubagent({ task: "t", tokenBudget: 1000, agent: runner });
    assert.deepEqual(out.budgetWarning, { kind: "tokens", limit: 1000, actual: 950 });
  });

  it("final usage below 80% → no budgetWarning", async () => {
    const runner = mkRunner(async (p) => {
      (p.opts.onUsage as ((u: ReturnType<typeof mkUsage>) => void) | undefined)?.(mkUsage(799, 0.01));
      return "ok";
    });
    const out = await spawnSubagent({ task: "t", tokenBudget: 1000, agent: runner });
    assert.equal(out.budgetWarning, undefined);
  });

  it("no budget set → no budgetWarning regardless of usage", async () => {
    const runner = mkRunner(async (p) => {
      (p.opts.onUsage as ((u: ReturnType<typeof mkUsage>) => void) | undefined)?.(mkUsage(1_000_000, 9));
      return "ok";
    });
    const out = await spawnSubagent({ task: "t", agent: runner });
    assert.equal(out.budgetWarning, undefined);
  });

  it("spend path: cost at 80% of spendBudget → spend warning", async () => {
    const runner = mkRunner(async (p) => {
      (p.opts.onUsage as ((u: ReturnType<typeof mkUsage>) => void) | undefined)?.(mkUsage(10, 0.4));
      return "ok";
    });
    const out = await spawnSubagent({ task: "t", spendBudget: 0.5, agent: runner });
    assert.deepEqual(out.budgetWarning, { kind: "spend", limit: 0.5, actual: 0.4 });
  });

  it("warning with retryOnTransient:true still does NOT retry (informational, not transient)", async () => {
    let n = 0;
    const runner = mkRunner(async (p) => {
      n++;
      (p.opts.onUsage as ((u: ReturnType<typeof mkUsage>) => void) | undefined)?.(mkUsage(900, 0.01));
      return "ok";
    });
    const out = await spawnSubagent({ task: "t", tokenBudget: 1000, retryOnTransient: true, agent: runner });
    assert.equal(n, 1, "a warned-but-successful run is never retried");
    assert.equal(out.failure, undefined);
  });
});

describe("spawnSubagent schema repair", () => {
  it("SCHEMA_NONCOMPLIANCE is transient → retried once (fresh re-run fixes the intermittent zai/glm flake)", async () => {
    const runner = mkRunner(async () => {
      if (runner.calls.length === 1) {
        throw new WorkflowError(
          "Subagent did not produce valid structured_output after repair attempts",
          WorkflowErrorCode.SCHEMA_NONCOMPLIANCE,
          { recoverable: false },
        );
      }
      return "ok";
    });
    const out = await spawnSubagent({ task: "t", agent: runner });
    assert.equal(out.failure, undefined);
    assert.equal(out.output, "ok");
    assert.equal(runner.calls.length, 2, "SCHEMA_NONCOMPLIANCE retried once");
  });

  it("forwards schemaRepairAttempts to runner.run as maxSchemaRetries", async () => {
    const runner = mkRunner(async () => "ok");
    await spawnSubagent({ task: "t", schemaRepairAttempts: 5, agent: runner });
    assert.equal(runner.calls[0]?.opts.maxSchemaRetries, 5);
  });

  it("SCHEMA_NONCOMPLIANCE NOT retried when retryOnTransient:false", async () => {
    const runner = mkRunner(async () => {
      throw new WorkflowError("no structured_output", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false });
    });
    const out = await spawnSubagent({ task: "t", retryOnTransient: false, agent: runner });
    assert.equal(out.failure?.kind, "failed");
    assert.equal(runner.calls.length, 1, "retryOnTransient:false → no retry");
  });
});

describe("spawnSubagent turns cap (maxTurns)", () => {
  const mkTurnsError = () =>
    new WorkflowError("max turns exceeded (5)", WorkflowErrorCode.TURNS_EXHAUSTED, {
      recoverable: false,
      details: { maxTurns: 5, turnsUsed: 5 },
    });

  it("TURNS_EXHAUSTED → transient, failure.kind turns carrying {maxTurns, turnsUsed}, retried once", async () => {
    const runner = mkRunner(async () => {
      throw mkTurnsError();
    });
    const out = await spawnSubagent({ task: "t", maxTurns: 5, retryOnTransient: true, agent: runner });
    assert.equal(runner.calls.length, 2, "turns exhaustion is transient (timeout-like) → retried once");
    assert.notEqual(out.failure?.kind, "timedout", "a turn cap is NOT a wall-clock timeout");
    assert.equal(out.failure?.kind, "turns");
    assert.deepEqual(out.failure?.kind === "turns" ? out.failure.turns : undefined, { maxTurns: 5, turnsUsed: 5 });
    assert.equal(out.output, "");
    assert.match(out.failure?.message ?? "", /max turns exceeded/);
  });

  it("TURNS_EXHAUSTED NOT retried when retryOnTransient:false", async () => {
    const runner = mkRunner(async () => {
      throw mkTurnsError();
    });
    const out = await spawnSubagent({ task: "t", maxTurns: 5, retryOnTransient: false, agent: runner });
    assert.equal(runner.calls.length, 1);
    assert.deepEqual(out.failure?.kind === "turns" ? out.failure.turns : undefined, { maxTurns: 5, turnsUsed: 5 });
  });

  it("forwards maxTurns to runner.run; omitted → undefined (no default)", async () => {
    const runner = mkRunner(async () => "ok");
    await spawnSubagent({ task: "t", maxTurns: 3, agent: runner });
    assert.equal(runner.calls[0]?.opts.maxTurns, 3);
    await spawnSubagent({ task: "t", agent: runner });
    assert.equal(runner.calls[1]?.opts.maxTurns, undefined, "omit = unlimited turns (no default injected)");
  });
});

describe("resolveSessionOverride (modelRuntime merge — ticket 07)", () => {
  const rt = { __fake: true } as any;
  it("no modelRuntime → session unchanged (passthrough)", () => {
    assert.equal(resolveSessionOverride(undefined, undefined), undefined);
    const s = { cwd: "/x" } as any;
    assert.equal(resolveSessionOverride(s, undefined), s);
  });
  it("modelRuntime set → merged into session", () => {
    assert.deepEqual(resolveSessionOverride(undefined, rt), { modelRuntime: rt });
    assert.deepEqual(resolveSessionOverride({ cwd: "/x" } as any, rt), { cwd: "/x", modelRuntime: rt });
  });
  it("top-level modelRuntime wins over session.modelRuntime", () => {
    const other = { __other: true } as any;
    assert.equal(resolveSessionOverride({ modelRuntime: other } as any, rt)?.modelRuntime, rt);
  });
});

// ── H1 (2026-08-15 hardening): derived run labels (was hardcoded "zk-spawn") ──

describe("deriveTaskLabel", () => {
  it("leading sentence of the first non-empty line, slugified", () => {
    assert.equal(deriveTaskLabel("Fix the login bug. Then verify."), "fix-the-login-bug");
  });

  it("caps at 40 chars with no trailing dashes", () => {
    const label = deriveTaskLabel(
      "investigate the flaky retry loop detector across every test file in the package now",
    );
    assert.ok(label.length <= 40, `label capped: "${label}"`);
    assert.match(label, /^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "slug-shaped, no leading/trailing dash");
  });

  it("skips blank leading lines", () => {
    assert.equal(deriveTaskLabel("\n\n  Write the report.\nsecond line"), "write-the-report");
  });

  it('falls back to "task" on empty/whitespace/slug-less input', () => {
    assert.equal(deriveTaskLabel(""), "task");
    assert.equal(deriveTaskLabel("   \n\t \n"), "task");
    assert.equal(deriveTaskLabel("!!! ???"), "task");
  });
});

describe("spawnSubagent label threading (H1)", () => {
  it("runner.run receives the derived label, not a hardcoded one", async () => {
    const runner = mkRunner(async () => "ok");
    await spawnSubagent({ task: "Do the thing now", tools: ["read"], agent: runner });
    assert.equal(runner.calls[0]?.opts.label, "do-the-thing-now");
  });

  it("an explicit label wins over derivation", async () => {
    const runner = mkRunner(async () => "ok");
    await spawnSubagent({ task: "anything at all", label: "pinned", tools: ["read"], agent: runner });
    assert.equal(runner.calls[0]?.opts.label, "pinned");
  });
});
