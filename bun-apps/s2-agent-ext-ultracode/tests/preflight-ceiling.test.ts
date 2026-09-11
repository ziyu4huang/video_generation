import { describe, expect, test } from "bun:test";
import {
  preflightCeilingDecision,
  ULTRA_SUGGESTED_TOKEN_BUDGET,
  ULTRA_WIDE_FANOUT_MIN_AGENTS,
} from "../src/effort-command.js";
import { createWorkflowTool } from "../src/workflow-tool.js";

function must<T>(value: T): NonNullable<T> {
  if (value == null) throw new Error("unexpected nil in test");
  return value;
}

/**
 * Self-arc-24 t02 — the pre-flight ceiling-confirm for ultra-armed unbounded
 * runs (CC permission-ASK parity). Closes the gap self-charted at
 * effort-command.ts ("input hook can't await a confirm"): the gate lives at the
 * tool boundary where tokenBudget/maxAgents are known and an await IS possible.
 */

const SCRIPT = "export const meta = { name: 't', description: 'd', phases: [{ title: 'P' }] };\nawait agent('x');\n";

describe("preflightCeilingDecision (pure matrix)", () => {
  const base = { effortLevel: "ultra", hasSelectionUi: true } as const;

  test("ultra + no budget + wide/unspecified fanout → confirm", () => {
    expect(preflightCeilingDecision({ ...base })).toEqual({
      action: "confirm",
      maxAgents: ULTRA_WIDE_FANOUT_MIN_AGENTS,
    });
    expect(preflightCeilingDecision({ ...base, maxAgents: 12 })).toEqual({ action: "confirm", maxAgents: 12 });
    expect(preflightCeilingDecision({ ...base, maxAgents: ULTRA_WIDE_FANOUT_MIN_AGENTS })).toEqual({
      action: "confirm",
      maxAgents: ULTRA_WIDE_FANOUT_MIN_AGENTS,
    });
  });

  test("skips: no ui / not ultra / budget present / narrow fanout", () => {
    expect(preflightCeilingDecision({ ...base, hasSelectionUi: false })).toEqual({ action: "skip", reason: "no-ui" });
    expect(preflightCeilingDecision({ ...base, effortLevel: "high" })).toEqual({ action: "skip", reason: "not-ultra" });
    expect(preflightCeilingDecision({ ...base, effortLevel: "off" })).toEqual({ action: "skip", reason: "not-ultra" });
    expect(preflightCeilingDecision({ ...base, tokenBudget: 1000 })).toEqual({
      action: "skip",
      reason: "budget-present",
    });
    expect(preflightCeilingDecision({ ...base, maxAgents: ULTRA_WIDE_FANOUT_MIN_AGENTS - 1 })).toEqual({
      action: "skip",
      reason: "narrow-fanout",
    });
  });
});

describe("pre-flight gate at the tool boundary", () => {
  function recordingManager() {
    const calls: Array<{ script: string; args: unknown; opts: any }> = [];
    const manager = {
      startInBackground(script: string, args: unknown, opts: any) {
        calls.push({ script, args, opts });
        return { runId: "stub-run" };
      },
      runSync(script: string, args: unknown, opts: any) {
        calls.push({ script, args, opts });
        return {
          result: { ok: true },
          meta: { name: "t", description: "d" },
          phases: ["P"],
          logs: [],
          agentCount: 1,
          durationMs: 0,
        };
      },
    };
    return { manager, calls };
  }

  function uiWithSelect(pick: () => string | undefined) {
    return {
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => {
          const choice = pick();
          return choice === undefined ? undefined : (options.find((o) => o.startsWith(choice)) ?? options[0]);
        },
      },
    };
  }

  async function run(params: Record<string, unknown>, effortLevel: "off" | "high" | "ultra", ctx: unknown) {
    const { manager, calls } = recordingManager();
    const tool = createWorkflowTool({ manager: manager as any, effort: { level: effortLevel } });
    const result = await tool.execute(
      "c",
      { script: SCRIPT, background: true, ...params } as any,
      undefined as any,
      undefined as any,
      ctx as any,
    );
    return { result, calls };
  }

  test("cap choice amends tokenBudget and proceeds", async () => {
    const { result, calls } = await run(
      { maxAgents: 12 },
      "ultra",
      uiWithSelect(() => "Cap"),
    );
    expect(calls).toHaveLength(1);
    expect(must(calls[0]).opts.tokenBudget).toBe(ULTRA_SUGGESTED_TOKEN_BUDGET);
    expect((result as any).details.runId).toBe("stub-run");
  });

  test("launch choice proceeds unbounded", async () => {
    const { calls } = await run(
      { maxAgents: 12 },
      "ultra",
      uiWithSelect(() => "Launch"),
    );
    expect(calls).toHaveLength(1);
    expect(must(calls[0]).opts.tokenBudget).toBeUndefined();
  });

  test("abort choice refuses before any run exists", async () => {
    const { result, calls } = await run(
      { maxAgents: 12 },
      "ultra",
      uiWithSelect(() => "Abort"),
    );
    expect(calls).toHaveLength(0);
    expect((result as any).details.aborted).toBe("ceiling-confirm");
    expect((result as any).content[0].text).toContain("aborted before launch");
  });

  test("dismissed dialog is fail-closed (treated as abort)", async () => {
    const { result, calls } = await run(
      { maxAgents: 12 },
      "ultra",
      uiWithSelect(() => undefined),
    );
    expect(calls).toHaveLength(0);
    expect((result as any).details.aborted).toBe("ceiling-confirm");
  });

  test("high effort never gates; explicit budget never gates", async () => {
    const high = await run(
      { maxAgents: 12 },
      "high",
      uiWithSelect(() => "Abort"),
    );
    expect(high.calls).toHaveLength(1);
    const budgeted = await run(
      { maxAgents: 12, tokenBudget: 500 },
      "ultra",
      uiWithSelect(() => "Abort"),
    );
    expect(budgeted.calls).toHaveLength(1);
    expect(must(budgeted.calls[0]).opts.tokenBudget).toBe(500);
  });
});
