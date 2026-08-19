/**
 * ext-api-get-all-tool-definitions — tests.
 *
 * Tests the pure logic of the patch by simulating the prototype modification
 * without needing the real SDK ExtensionRunner. The import-time integration
 * side effect is tested via the real import (will be exercised by any test
 * that loads the workspace, e.g. through index.test.ts applyPatches).
 */
import { describe, expect, test } from "bun:test";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A mock ExtensionRunner-like instance for testing the patch logic. */
function createMockRunner(): {
  runtime: Record<string, unknown>;
  bindCore: (...args: unknown[]) => void;
  bindCoreCallCount: number;
  bindCoreArgs: unknown[][];
  getAllRegisteredToolsCallCount: number;
  getAllRegisteredTools: () => Array<{ definition: Record<string, unknown>; sourceInfo: { source: string } }>;
  assertActive: () => void;
} {
  const runner = {
    runtime: {} as Record<string, unknown>,
    bindCoreCallCount: 0,
    bindCoreArgs: [] as unknown[][],
    getAllRegisteredToolsCallCount: 0,
    registeredTools: [
      { definition: { name: "tool_a", execute: () => "a" }, sourceInfo: { source: "test" } },
      { definition: { name: "tool_b", execute: () => "b" }, sourceInfo: { source: "test" } },
    ],
    bindCore(...args: unknown[]) {
      this.bindCoreCallCount++;
      this.bindCoreArgs.push(args);
    },
    getAllRegisteredTools() {
      this.getAllRegisteredToolsCallCount++;
      return this.registeredTools;
    },
    assertActive() {},
  };
  return runner;
}

/**
 * Simulate what the patch does: wrap bindCore to also set
 * runtime.getAllToolDefinitions after the original.
 */
function applyPatchToMock(
  runner: ReturnType<typeof createMockRunner>,
): void {
  const originalBindCore = runner.bindCore.bind(runner);
  runner.bindCore = function (this: unknown, ...args: unknown[]) {
    originalBindCore(...args);
    const runtime = (this as Record<string, unknown>).runtime as Record<string, unknown>;
    if (!runtime) return;
    if (typeof runtime.getAllToolDefinitions === "function") return;
    const self = this as unknown as ReturnType<typeof createMockRunner>;
    runtime.getAllToolDefinitions = () => {
      try { self.assertActive(); } catch { return []; }
      return self.getAllRegisteredTools().map((t) => t.definition);
    };
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("applyGetAllToolDefinitionsPatch logic", () => {
  test("adds getAllToolDefinitions to runtime after bindCore", () => {
    const runner = createMockRunner();
    applyPatchToMock(runner);

    // Call bindCore — should set getAllToolDefinitions on runtime
    runner.bindCore({ actions: "mock" });

    expect(runner.bindCoreCallCount).toBe(1);
    expect(typeof runner.runtime.getAllToolDefinitions).toBe("function");

    const defs = (runner.runtime.getAllToolDefinitions as () => unknown[])() as Array<Record<string, unknown>>;
    expect(defs).toHaveLength(2);
    expect(defs[0]!.name).toBe("tool_a");
    expect(defs[0]!.execute).toBeInstanceOf(Function);
    expect(defs[1]!.name).toBe("tool_b");
  });

  test("getAllToolDefinitions returns full ToolDefinition (with execute)", () => {
    const runner = createMockRunner();
    applyPatchToMock(runner);
    runner.bindCore();

    const defs = (runner.runtime.getAllToolDefinitions as () => unknown[])() as Array<Record<string, unknown>>;
    expect((defs[0]!.execute as () => string)()).toBe("a");
    expect((defs[1]!.execute as () => string)()).toBe("b");
  });

  test("does not override existing getAllToolDefinitions (upstream fix safety)", () => {
    const runner = createMockRunner();
    runner.runtime.getAllToolDefinitions = () => [{ name: "upstream", execute: () => "upstream" }];
    applyPatchToMock(runner);
    runner.bindCore();

    const defs = (runner.runtime.getAllToolDefinitions as () => unknown[])() as Array<Record<string, unknown>>;
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe("upstream"); // kept the original
  });

  test("getAllRegisteredTools delegating — counts match", () => {
    const runner = createMockRunner();
    applyPatchToMock(runner);
    runner.bindCore();

    // Verify getAllToolDefinitions calls getAllRegisteredTools
    const before = runner.getAllRegisteredToolsCallCount;
    (runner.runtime.getAllToolDefinitions as () => unknown[])();
    expect(runner.getAllRegisteredToolsCallCount).toBe(before + 1);
  });

  test("assertActive throw → returns empty array gracefully", () => {
    const runner = createMockRunner();
    runner.assertActive = () => { throw new Error("stale"); };
    applyPatchToMock(runner);
    runner.bindCore();

    const defs = (runner.runtime.getAllToolDefinitions as () => unknown[])();
    expect(defs).toEqual([]);
  });
});

// The module-level "does it export an applied flag" check lives in
// patch-outcome.test.ts, which imports this module in a SUBPROCESS (these
// patches apply at import time and are idempotent-guarded, so a second import
// in this process reports false for the honest reason "already applied") and
// asserts a real boolean outcome. The integration test that used to sit here
// asserted a hardcoded `= true` constant equalled true — it could not fail.
