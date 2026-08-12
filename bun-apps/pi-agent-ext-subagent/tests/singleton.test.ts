import { describe, expect, it } from "bun:test";
import { getSubagentInFlightRegistry, SubagentInFlightRegistry } from "@repo/pi-agent-ext-core-runtime";
import { createSubagentRunPersistence, getSubagentRunPersistence } from "../src/subagent-run-persistence.js";

describe("subagent singletons", () => {
  it("getSubagentInFlightRegistry returns one shared instance", () => {
    expect(getSubagentInFlightRegistry()).toBe(getSubagentInFlightRegistry());
    expect(getSubagentInFlightRegistry()).toBeInstanceOf(SubagentInFlightRegistry);
  });
  it("getSubagentRunPersistence returns one shared instance", () => {
    expect(getSubagentRunPersistence()).toBe(getSubagentRunPersistence());
  });
  it("factories still construct independent instances (test injection)", () => {
    expect(new SubagentInFlightRegistry()).not.toBe(getSubagentInFlightRegistry());
    expect(createSubagentRunPersistence()).not.toBe(getSubagentRunPersistence());
  });
});
