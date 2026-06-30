import { test, expect, describe } from "bun:test";
import { validateToolNames, modelLabel } from "../sessions/shared.ts";

/** Minimal stand-in for a pi-core session: only getActiveToolNames is used. */
function mockSession(active: string[]): { getActiveToolNames: () => string[] } {
  return { getActiveToolNames: () => active };
}

describe("validateToolNames — fail-fast on unknown --tools", () => {
  test("undefined requested → no throw", () => {
    expect(() => validateToolNames(mockSession(["read"]), undefined, undefined)).not.toThrow();
  });

  test("empty requested → no throw", () => {
    expect(() => validateToolNames(mockSession(["read"]), [], undefined)).not.toThrow();
  });

  test("all requested names are active → no throw", () => {
    expect(() =>
      validateToolNames(mockSession(["read", "bash", "obsidian_read"]), ["read", "bash"], undefined),
    ).not.toThrow();
  });

  test("typo'd name (not active) → throws and names it", () => {
    expect(() =>
      validateToolNames(mockSession(["read", "bash"]), ["obsidian_distil", "obsidian_reed"], undefined),
    ).toThrow(/obsidian_distil[\s\S]*obsidian_reed/);
  });

  test("mixed valid + typo → throws listing only the typo", () => {
    const fn = () => validateToolNames(mockSession(["read", "bash"]), ["read", "obsidian_distil"], undefined);
    expect(fn).toThrow();
    try {
      fn();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("obsidian_distil");
      expect(msg).not.toMatch(/\bread\b/); // valid name not flagged
    }
  });

  test("name absent from active BUT in excludeTools → NOT flagged (exclusion explains absence)", () => {
    // `--tools read,bash --exclude-tools bash` → bash not active, but excluded → OK.
    expect(() =>
      validateToolNames(mockSession(["read"]), ["read", "bash"], ["bash"]),
    ).not.toThrow();
  });

  test("error message points the user at --list-tools", () => {
    try {
      validateToolNames(mockSession(["read"]), ["bogus"], undefined);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toMatch(/--list-tools/);
    }
  });

  test("session without getActiveToolNames → no throw (cannot validate, don't block)", () => {
    expect(() => validateToolNames({} as never, ["bogus"], undefined)).not.toThrow();
  });
});

describe("modelLabel — display name with provider/id fallback", () => {
  const llm = { provider: "zai", modelId: "glm-5.2" };

  test("uses the registry display name when present", () => {
    expect(modelLabel({ model: { name: "GLM 5.2" } }, llm)).toBe("GLM 5.2");
  });

  test("falls back to provider/modelId when no display name", () => {
    expect(modelLabel({}, llm)).toBe("zai/glm-5.2");
    expect(modelLabel({ model: {} }, llm)).toBe("zai/glm-5.2");
  });
});
