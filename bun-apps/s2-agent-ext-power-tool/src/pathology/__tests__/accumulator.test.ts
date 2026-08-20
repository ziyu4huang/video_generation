/**
 * Tests for the hook-fed call accumulator (module-scoped ring buffer).
 *
 * State is module-scoped, so each test resets via resetAccumulator() in
 * beforeEach. (bun test isolates module state per FILE anyway, so this state
 * never leaks into index.test.ts / detector.test.ts.)
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { recordCallStart, recordCallEnd, getCalls, getTurnCount, recordTurnEnd, resetAccumulator } from "../accumulator.ts";

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

describe("accumulator — turn counting (v2)", () => {
  beforeEach(() => resetAccumulator());

  test("recordTurnEnd tracks completed-turn count (turnIndex + 1)", () => {
    recordTurnEnd({ turnIndex: 0 });
    expect(getTurnCount()).toBe(1);
    recordTurnEnd({ turnIndex: 14 });
    expect(getTurnCount()).toBe(15);
  });

  test("getTurnCount is null before any turn ends", () => {
    expect(getTurnCount()).toBeNull();
  });

  test("resetAccumulator clears turn count", () => {
    recordTurnEnd({ turnIndex: 5 });
    expect(getTurnCount()).toBe(6);
    resetAccumulator();
    expect(getTurnCount()).toBeNull();
  });
});

describe("accumulator — session isolation (optimization #3 / ticket #16)", () => {
  beforeEach(() => resetAccumulator());

  test("#3 accumulator isolated per sessionId (parent vs in-process child)", () => {
    const parentSid = "parent-uuid";
    const childSid = "child-uuid";
    resetAccumulator(); // clear all buckets

    // Parent records a call.
    recordCallStart({ toolCallId: "p1", toolName: "bash", args: { command: "x" } }, parentSid);
    recordCallEnd({ toolCallId: "p1", toolName: "bash", result: "ok", isError: false }, parentSid);
    // Child records a different call.
    recordCallStart({ toolCallId: "c1", toolName: "read", args: { path: "y" } }, childSid);
    recordCallEnd({ toolCallId: "c1", toolName: "read", result: "ok", isError: false }, childSid);

    // Independent buffers — child did not pollute the parent (the ticket #16 bug).
    expect(getCalls(parentSid)).toHaveLength(1);
    expect(getCalls(parentSid)[0].toolName).toBe("bash");
    expect(getCalls(childSid)).toHaveLength(1);
    expect(getCalls(childSid)[0].toolName).toBe("read");

    // Resetting the child does NOT touch the parent.
    resetAccumulator(childSid);
    expect(getCalls(childSid)).toHaveLength(0);
    expect(getCalls(parentSid)).toHaveLength(1);

    // A no-sid caller hits the "" fallback bucket (legacy) and does NOT touch a
    // named bucket — so ctx-less code paths can never crosstalk with a session.
    recordCallStart({ toolCallId: "n1", toolName: "edit", args: {} });
    expect(getCalls()).toHaveLength(1);
    expect(getCalls(parentSid)).toHaveLength(1);
  });

  test("turnCount is isolated per sessionId", () => {
    const parentSid = "parent-uuid";
    const childSid = "child-uuid";
    resetAccumulator();

    recordTurnEnd({ turnIndex: 2 }, parentSid);
    expect(getTurnCount(parentSid)).toBe(3);
    // Child never saw a turn_end — null, not the parent's count.
    expect(getTurnCount(childSid)).toBeNull();
    // A never-seen sid is also null (empty bucket).
    expect(getTurnCount("never-seen")).toBeNull();

    // Child's turn doesn't move the parent's count.
    recordTurnEnd({ turnIndex: 0 }, childSid);
    expect(getTurnCount(childSid)).toBe(1);
    expect(getTurnCount(parentSid)).toBe(3);
  });
});
