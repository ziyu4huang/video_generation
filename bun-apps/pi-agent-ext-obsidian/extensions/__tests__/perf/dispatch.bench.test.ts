/**
 * dispatch.bench.test.ts — measures obsidian's runtime Value.Check dispatch
 * validation (validateActionArgs). Pure-CPU, deterministic. Reports p50/p95
 * and asserts a generous 5ms ceiling (baseline is sub-millisecond).
 */
import { test, expect, describe } from "bun:test";
import { benchLatency } from "../../../../perf-harness/src/index.ts";
import { validateActionArgs } from "../../obsidian.ts";

// Minimal schema resolver — obsidian_read's schema shape
const fakeSchema = {
  type: "object",
  properties: { note: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } },
  required: ["note"],
};
const resolveSchema = (_action: string) => fakeSchema;

describe("obsidian dispatch latency", () => {
  test("validateActionArgs p95 < 5ms", async () => {
    const result = await benchLatency("validateActionArgs(valid)", () =>
      Promise.resolve(validateActionArgs("read", { note: "Inbox.md" }, resolveSchema)),
    );
    console.log(`  validateActionArgs: p50=${result.p50.toFixed(3)}ms p95=${result.p95.toFixed(3)}ms`);
    expect(result.p95).toBeLessThan(5);
  });
});
