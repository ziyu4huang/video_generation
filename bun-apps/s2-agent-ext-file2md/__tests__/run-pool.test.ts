/**
 * runPool (T2) — the bounded-concurrency runner used for parallel page
 * extraction. Pure timing/contract test: no model, no fs.
 *
 *   bun test __tests__/run-pool.test.ts
 */
import { describe, expect, test } from "bun:test";
import { runPool } from "../src/pipeline.ts";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("runPool (T2 concurrency)", () => {
  test("processes all items", async () => {
    const done: number[] = [];
    await runPool([1, 2, 3, 4, 5], 2, async (n) => {
      done.push(n);
      await delay(0);
    });
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  test("respects the cap AND actually runs in parallel (2 ≤ max-in-flight ≤ limit)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await runPool([1, 2, 3, 4, 5, 6], 3, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5);
      inFlight--;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThanOrEqual(2); // genuinely concurrent, not serial
  });

  test("limit < 1 is treated as 1 (serial)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await runPool([1, 2, 3], 0, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(2);
      inFlight--;
    });
    expect(maxInFlight).toBe(1);
  });

  test("empty items → no invocations", async () => {
    let calls = 0;
    await runPool([], 4, async () => {
      calls++;
    });
    expect(calls).toBe(0);
  });

  test("limit > items.length processes all without extra workers", async () => {
    const done: number[] = [];
    await runPool([1, 2], 10, async (n) => {
      done.push(n);
    });
    expect(done.sort()).toEqual([1, 2]);
  });
});
