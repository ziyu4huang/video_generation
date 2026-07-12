import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimate, reserve, reconcile, refund, costSnapshot, getLog, configureBudget, DEFAULT_BUDGET, BudgetExceededError, retagTool } from "./cost.ts";

let env: Record<string, string | undefined>;
beforeEach(() => {
  env = { MLX_OUTPUT_DIR: mkdtempSync(join(tmpdir(), "md-cost-")) };
});

describe("cost tracker lifecycle", () => {
  test("estimate → reserve → reconcile settles the entry", () => {
    const id = estimate("p1", "krea2_image", "t2i", 0.05, env);
    expect(getLog("p1", env).entries[0]!.status).toBe("estimated");
    reserve("p1", id, env);
    expect(getLog("p1", env).entries[0]!.status).toBe("reserved");
    reconcile("p1", id, 0.04, true, env);
    expect(getLog("p1", env).entries[0]!.status).toBe("completed");
    const snap = costSnapshot("p1", env);
    expect(snap.total_spent_usd).toBe(0.04);
    expect(snap.total_reserved_usd).toBe(0);
  });

  test("refund returns a reserved entry", () => {
    const id = estimate("p1", "ltx_video", "i2v", 0.1, env);
    reserve("p1", id, env);
    refund("p1", id, env);
    expect(getLog("p1", env).entries[0]!.status).toBe("refunded");
    expect(costSnapshot("p1", env).total_spent_usd).toBe(0);
  });

  test("snapshot reflects reserved + spent separately", () => {
    const a = estimate("p1", "krea2_image", "t2i", 0.05, env);
    reserve("p1", a, env);
    const b = estimate("p1", "krea2_image", "t2i", 0.05, env);
    reserve("p1", b, env);
    reconcile("p1", b, 0.05, true, env);
    const snap = costSnapshot("p1", env);
    expect(snap.total_reserved_usd).toBe(0.05);
    expect(snap.total_spent_usd).toBe(0.05);
  });

  test("cap mode: reserve over usable budget raises BudgetExceededError", () => {
    configureBudget("p1", { mode: "cap", totalUsd: 0.5, singleActionApprovalUsd: 100 }, env); // tiny budget, high single-action threshold so the CAP fires
    const id = estimate("p1", "ltx_video", "i2v", 5.0, env); // far over budget
    expect(() => reserve("p1", id, env)).toThrow(BudgetExceededError);
  });
});

// Item 2 (manifest-consistency guard, output/next-goal-20260712_135012.md):
// orchestration.budget_default_usd was pure YAML documentation with zero
// runtime consumer — DEFAULT_BUDGET.totalUsd=10 silently overrode whatever a
// pipeline manifest declared. estimate()'s optional `pipeline` param closes
// that gap for freshly-created projects only.
describe("budget seeded from pipeline manifest (Item 2)", () => {
  test("a brand-new project with no pipeline hint gets DEFAULT_BUDGET.totalUsd", () => {
    estimate("p1", "krea2_image", "t2i", 0.05, env);
    expect(getLog("p1", env).budget.totalUsd).toBe(DEFAULT_BUDGET.totalUsd);
  });

  test("a brand-new project seeds totalUsd from orchestration.budget_default_usd when pipeline is given", () => {
    // talking-head.yaml declares orchestration.budget_default_usd: 0.50
    estimate("p1", "krea2_image", "t2i", 0.05, env, "talking-head");
    expect(getLog("p1", env).budget.totalUsd).toBe(0.5);
  });

  test("a different pipeline's default is used correctly (animated-explainer: 2.00)", () => {
    estimate("p1", "krea2_image", "t2i", 0.05, env, "animated-explainer");
    expect(getLog("p1", env).budget.totalUsd).toBe(2.0);
  });

  test("pipeline hint is ignored once a cost log already exists", () => {
    estimate("p1", "krea2_image", "t2i", 0.05, env); // creates log with DEFAULT_BUDGET
    estimate("p1", "krea2_image", "t2i", 0.05, env, "animated-explainer"); // should NOT re-seed
    expect(getLog("p1", env).budget.totalUsd).toBe(DEFAULT_BUDGET.totalUsd);
  });
});

// Item 3 (generate's internal refactor, output/next-goal-20260712_135012.md):
// retagTool corrects a cost entry's `tool` when the actually-invoked provider
// diverges from the pre-resolved one (e.g. selectAndGenerate's tts
// edge-tts-over-say opportunistic upgrade), so the persisted log attributes
// cost to what actually ran, not the pre-generation guess.
describe("retagTool (Item 3)", () => {
  test("updates the entry's tool field", () => {
    const id = estimate("p1", "say", "tts:synthesize", 0.0, env);
    retagTool("p1", id, "edge-tts", env);
    expect(getLog("p1", env).entries[0]!.tool).toBe("edge-tts");
  });

  test("is a no-op for an unknown entry id", () => {
    estimate("p1", "say", "tts:synthesize", 0.0, env);
    retagTool("p1", "does-not-exist", "edge-tts", env);
    expect(getLog("p1", env).entries[0]!.tool).toBe("say");
  });
});
