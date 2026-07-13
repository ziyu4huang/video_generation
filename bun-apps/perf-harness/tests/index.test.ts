import { test, expect, describe } from "bun:test";
import {
  createCapturePi,
  captureTools,
  estimateSchemaTokens,
  estimateTotalSchemaTokens,
} from "../src/index.ts";

describe("createCapturePi", () => {
  test("captures registerTool calls by tool name", () => {
    const { pi, tools } = createCapturePi();
    pi.registerTool({ name: "alpha", description: "d", parameters: {} });
    pi.registerTool({ name: "beta", description: "e", parameters: {} });
    expect(Object.keys(tools).sort()).toEqual(["alpha", "beta"]);
  });

  test("swallows other pi methods (registerCommand, on, etc.) without throwing", () => {
    const { pi } = createCapturePi();
    expect(() => pi.registerCommand()).not.toThrow();
    expect(() => pi.on("event", () => {})).not.toThrow();
    expect(() => pi.unknownMethod()).not.toThrow();
  });

  test("provides pi.events for knowledge-card host-fn bus", () => {
    const { pi } = createCapturePi();
    expect(() => pi.events.emit("ch", {})).not.toThrow();
    expect(() => pi.events.on("ch", () => {})).not.toThrow();
  });
});

describe("captureTools", () => {
  test("runs a factory and returns captured tools", () => {
    const factory = (pi: any) => {
      pi.registerTool({ name: "t1", description: "x", parameters: { type: "object" } });
    };
    const tools = captureTools(factory);
    expect(tools.t1).toBeDefined();
    expect(tools.t1.name).toBe("t1");
  });
});

describe("estimateSchemaTokens", () => {
  test("returns chars + tokens (chars/4 rounded)", () => {
    const tool = { name: "x", description: "abcd", parameters: { type: "object" } };
    const { chars, tokens } = estimateSchemaTokens(tool);
    expect(chars).toBe(JSON.stringify({ name: "x", description: "abcd", parameters: { type: "object" } }).length);
    expect(tokens).toBe(Math.round(chars / 4));
  });
});

describe("estimateTotalSchemaTokens", () => {
  test("sums per-tool + total, sorts desc by tokens", () => {
    const tools = {
      big: { name: "big", description: "x".repeat(100), parameters: {} },
      small: { name: "small", description: "y", parameters: {} },
    };
    const { perTool, total } = estimateTotalSchemaTokens(tools);
    expect(perTool[0].name).toBe("big");
    expect(perTool[1].name).toBe("small");
    expect(total.tokens).toBe(perTool[0].tokens + perTool[1].tokens);
    expect(total.chars).toBe(perTool[0].chars + perTool[1].chars);
  });
});
