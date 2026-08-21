/**
 * Regression guards for D8-2 / D8-3 (audit docket 2026-07-18):
 * `agent(prompt, { schema })` returns `null` on recoverable exhaustion
 * (retries exhausted / transient failure / timeout). The generated
 * deep-research and adversarial-review scripts dereference the schema result
 * directly (`plan.queries`, `investigation.findings`) — a recoverable null
 * must NOT crash with a bare `TypeError: Cannot read properties of null`.
 * It must surface a clear, attributable error so the caller knows the cause.
 *
 * Harness mirrors `regression-ext-workflow-protection.test.ts`: call the
 * generator to get the script source, run it via `runWorkflow` with a mock
 * agent that returns `null` (recoverable exhaustion), and assert the run
 * fails with our clear error message rather than an opaque TypeError.
 */

import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import path from "node:path";
import { generateAdversarialReviewWorkflow } from "../src/adversarial-review.js";
import { generateDeepResearchWorkflow } from "../src/deep-research.js";
import { runWorkflow } from "../src/workflow.js";

const REPO = path.resolve(import.meta.dir, "../../..");

/**
 * Mock agent that returns null for the schema-bearing investigator / planner
 * calls (recoverable exhaustion), and a benign empty object for any other
 * call so the run reaches the guarded dereference before any later phase.
 */
function nullSchemaAgent() {
  return {
    async run(_prompt: string) {
      return null;
    },
  };
}

describe("builtin workflow null-guard — deep_research (D8-2)", () => {
  it("plan-queries agent returning null → clear error, not bare TypeError", async () => {
    const source = generateDeepResearchWorkflow();
    let caught: unknown;
    try {
      await runWorkflow(source, {
        cwd: REPO,
        // agentRetries:0 short-circuits the attempt loop → agent() resolves
        // null without ever invoking run() (the realistic recoverable path).
        agentRetries: 0,
        agent: nullSchemaAgent(),
        persistLogs: false,
        args: { question: "what is X?", angles: 2, minSupport: 1 },
      });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "runWorkflow must reject when the plan-queries agent returns null");
    const msg = (caught instanceof Error ? caught.message : String(caught)).toString();
    assert.ok(
      /deep-research: plan-queries agent returned no result/i.test(msg),
      `expected clear deep-research error message, got: ${msg}`,
    );
    // MUST NOT leak the bare TypeError that D8-2 was filed against.
    assert.ok(
      !/Cannot read properties of null \(reading 'queries'\)/i.test(msg),
      `must not surface bare TypeError, got: ${msg}`,
    );
  });
});

describe("builtin workflow null-guard — adversarial_review (D8-3)", () => {
  it("investigation agent returning null → clear error, not bare TypeError", async () => {
    const source = generateAdversarialReviewWorkflow();
    let caught: unknown;
    try {
      await runWorkflow(source, {
        cwd: REPO,
        agentRetries: 0,
        agent: nullSchemaAgent(),
        persistLogs: false,
        args: { task: "review X", reviewers: 2, threshold: 0.5 },
      });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "runWorkflow must reject when the investigation agent returns null");
    const msg = (caught instanceof Error ? caught.message : String(caught)).toString();
    assert.ok(
      /adversarial-review: investigation agent returned no result/i.test(msg),
      `expected clear adversarial-review error message, got: ${msg}`,
    );
    assert.ok(
      !/Cannot read properties of null \(reading 'findings'\)/i.test(msg),
      `must not surface bare TypeError, got: ${msg}`,
    );
  });
});
