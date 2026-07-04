import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimate, reserve, reconcile, refund, costSnapshot, getLog, configureBudget, BudgetExceededError } from "./cost.ts";

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
