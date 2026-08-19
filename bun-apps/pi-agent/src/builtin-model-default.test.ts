/** builtin-model-default — unit tests for the single-source built-in defaults. */
import { describe, expect, test } from "bun:test";
import { BUILTIN_MODEL_DEFAULT } from "./builtin-model-default.ts";

describe("BUILTIN_MODEL_DEFAULT", () => {
  test("provider/model match the repo standard (zai/glm-5.3)", () => {
    expect(BUILTIN_MODEL_DEFAULT.provider).toBe("zai");
    expect(BUILTIN_MODEL_DEFAULT.model).toBe("glm-5.3");
  });

  test("thinking is a valid pi-agent-core ThinkingLevel", () => {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
    expect(levels).toContain(BUILTIN_MODEL_DEFAULT.thinking);
  });

  test("obsidian floor is provider-qualified (usable as OB_SUBAGENT_MODEL)", () => {
    expect(BUILTIN_MODEL_DEFAULT.obsidianSubagentFloor).toMatch(/^[^/]+\/.+$/);
  });
});
