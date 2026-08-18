import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelTierConfig } from "@repo/pi-agent-core-runtime";
import type { SpawnSubagentResult } from "../src/spawn-subagent.js";
import { runModelReview } from "../src/watchdog/model-review.js";

/**
 * Hermetic model-tiers config injected via the `loadConfig` seam so the test
 * does NOT depend on ~/.pi/workflows/model-tiers.json existing (CI has none).
 * reviewSpec resolves to the capability entry; tiers.big is the fallback.
 */
const mockCfg: ModelTierConfig = {
  tiers: { big: "zai/glm-5.2" },
  capabilities: { review: "zai/glm-5.2:high" },
};

function okFinding(): SpawnSubagentResult {
  // schema-shaped JSON the review subagent would return (spawnSubagent stringifies it)
  return {
    output: JSON.stringify({
      findings: [
        { severity: "blocker", source: "model", path: "a.ts", message: "impl missing", suggestedFix: "add it" },
      ],
    }),
  };
}

describe("model-review", () => {
  it("parses structured findings from the review subagent", async () => {
    const r = await runModelReview({
      cwd: process.cwd(),
      diffText: "diff",
      taskLabel: "t",
      loadConfig: () => mockCfg,
      // @ts-expect-error inject a mock runner
      agent: { run: async () => JSON.parse(okFinding().output) },
    });
    assert.equal(r.ran, true);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0]?.severity, "blocker");
  });

  it("degrades to a concern note when the review errors", async () => {
    const r = await runModelReview({
      cwd: process.cwd(),
      diffText: "diff",
      taskLabel: "t",
      loadConfig: () => mockCfg,
      // @ts-expect-error mock runner that throws
      agent: {
        run: async () => {
          throw new Error("boom");
        },
      },
    });
    assert.equal(r.ran, false);
    assert.match(r.note ?? "", /review-skipped|boom/);
  });

  it("caps the L2 reviewer with the recon envelope (caps + footer travel together)", async () => {
    let task = "";
    let opts: Record<string, unknown> = {};
    const agent = {
      run: async (t: string, o: Record<string, unknown>) => {
        task = t;
        opts = o;
        return JSON.parse(okFinding().output);
      },
    };
    await runModelReview({
      cwd: process.cwd(),
      diffText: "diff",
      taskLabel: "t",
      loadConfig: () => mockCfg,
      // @ts-expect-error inject a mock runner
      agent,
    });
    assert.match(task, /--- abort-safety/);
    assert.match(task, /\/tmp\/subagent-runs\/watchdog-l2-\d+\.md/);
    assert.equal(opts.tokenBudget, 120_000);
    assert.equal(opts.maxTurns, 12);
  });

  it("SUBAGENT_TOKEN_BUDGET_DISABLE strips the L2 caps and footer", async () => {
    const prev = process.env.SUBAGENT_TOKEN_BUDGET_DISABLE;
    process.env.SUBAGENT_TOKEN_BUDGET_DISABLE = "1";
    try {
      let task = "";
      let opts: Record<string, unknown> = {};
      const agent = {
        run: async (t: string, o: Record<string, unknown>) => {
          task = t;
          opts = o;
          return JSON.parse(okFinding().output);
        },
      };
      await runModelReview({
        cwd: process.cwd(),
        diffText: "diff",
        taskLabel: "t",
        loadConfig: () => mockCfg,
        // @ts-expect-error inject a mock runner
        agent,
      });
      assert.equal(task.includes("abort-safety"), false);
      assert.equal(opts.tokenBudget, undefined);
      assert.equal(opts.maxTurns, undefined);
    } finally {
      if (prev === undefined) delete process.env.SUBAGENT_TOKEN_BUDGET_DISABLE;
      else process.env.SUBAGENT_TOKEN_BUDGET_DISABLE = prev;
    }
  });
});
