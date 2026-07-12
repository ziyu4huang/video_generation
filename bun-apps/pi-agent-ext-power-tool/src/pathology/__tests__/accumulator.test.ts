/**
 * Tests for the hook-fed call accumulator (module-scoped ring buffer).
 *
 * State is module-scoped, so each test resets via resetAccumulator() in
 * beforeEach. (bun test isolates module state per FILE anyway, so this state
 * never leaks into index.test.ts / detector.test.ts.)
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { recordCallStart, recordCallEnd, getCalls, resetAccumulator } from "../accumulator.ts";

describe("accumulator", () => {
  beforeEach(() => resetAccumulator());

  test("recordCallStart pushes a call with isError=false and a stable argsSig", () => {
    recordCallStart({ toolCallId: "1", toolName: "bash", args: { command: "ls" } });
    const c = getCalls();
    expect(c).toHaveLength(1);
    expect(c[0].toolName).toBe("bash");
    expect(c[0].isError).toBe(false);
    expect(c[0].argsSig).toContain("command");
  });

  test("recordCallEnd marks the matching call's error state by toolCallId", () => {
    recordCallStart({ toolCallId: "1", toolName: "bash", args: {} });
    recordCallEnd({ toolCallId: "1", toolName: "bash", result: "boom", isError: true });
    expect(getCalls()[0].isError).toBe(true);
  });

  test("a successful end leaves isError=false", () => {
    recordCallStart({ toolCallId: "1", toolName: "read", args: { path: "a" } });
    recordCallEnd({ toolCallId: "1", toolName: "read", result: "ok", isError: false });
    expect(getCalls()[0].isError).toBe(false);
  });

  test("recordCallEnd with an unknown toolCallId still records the fact (defensive)", () => {
    recordCallEnd({ toolCallId: "ghost", toolName: "read", result: "err", isError: true });
    const c = getCalls();
    expect(c).toHaveLength(1);
    expect(c[0].isError).toBe(true);
    expect(c[0].toolName).toBe("read");
  });

  test("resetAccumulator clears all state", () => {
    recordCallStart({ toolCallId: "1", toolName: "bash", args: {} });
    expect(getCalls()).toHaveLength(1);
    resetAccumulator();
    expect(getCalls()).toHaveLength(0);
  });
});
