import { describe, expect, it } from "bun:test";
import { subagentToolSchema } from "../src/subagent-tool-schema.js";

const PARAMS = (subagentToolSchema as any).properties as Record<string, { type: string; description: string }>;
const EXPECTED = [
  "agent",
  "agentType",
  "task",
  "model",
  "tier",
  "cwd",
  "tools",
  "excludeTools",
  "timeoutMs",
  "tokenBudget",
  "spendBudget",
  "retryOnTransient",
  "commitScope",
  "schema",
  "schemaRepairAttempts",
];

describe("subagent tool schema — slimmed weight", () => {
  it("keeps every parameter with its optionality and type", () => {
    for (const name of EXPECTED) {
      expect(PARAMS[name], `missing param ${name}`).toBeDefined();
    }
    // task is required; all others optional
    const required = (subagentToolSchema as any).required as string[];
    expect(required).toEqual(["task"]);
  });

  it("each description is terse (< 240 chars) — was up to ~360", () => {
    for (const name of EXPECTED) {
      const len = PARAMS[name].description.length;
      expect(len, `${name} desc ${len} chars`).toBeLessThan(240);
    }
  });

  it("preserves load-bearing semantic warnings (not just truncated)", () => {
    const joined = Object.values(PARAMS)
      .map((p) => p.description)
      .join("\n");
    // These phrases MUST survive the slim — they prevent real misuse.
    expect(joined).toContain("NO access to this session's history"); // task
    expect(joined).toContain("only pass a model you know is configured"); // model
    expect(joined).toContain("never auto-reverts"); // commitScope
    expect(joined).toContain("non-recoverable"); // tokenBudget
  });
});
