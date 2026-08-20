import { describe, expect, it } from "bun:test";
import {
  createSubagentRunPersistence,
  getSubagentInFlightRegistry,
  getSubagentRunPersistence,
  SubagentInFlightRegistry,
} from "@repo/s2-agent-core-runtime";

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
