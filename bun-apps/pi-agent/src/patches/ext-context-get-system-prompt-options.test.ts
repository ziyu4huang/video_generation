/**
 * Regression test for the /goal command crash.
 *
 * Bug: ext-context-get-system-prompt-options originally added
 * `getSystemPromptOptions` to createContext() as a GETTER-ONLY accessor.
 * createCommandContext() copies descriptors via getOwnPropertyDescriptors +
 * Object.defineProperties, then overwrites the property via plain assignment
 * (`context.getSystemPromptOptions = () => {...}`). Plain assignment to a
 * getter-only accessor throws in strict mode
 * ("Attempted to assign to readonly property"), which broke EVERY extension
 * slash-command (notably /goal) at dispatch time.
 *
 * Fix: define the property as a writable, configurable DATA property so the
 * assignment override in createCommandContext succeeds.
 */
import { describe, expect, test } from "bun:test";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
// Importing the patch module applies its import-time side effect (patches
// ExtensionRunner.prototype.createContext). Idempotent — safe to re-import.
import "./ext-context-get-system-prompt-options.ts";

function makeRunner() {
  // createCommandContext needs getSystemPromptOptionsFn + assertActive bound.
  // Minimally stub them; createContext()'s getter still calls assertActive().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runner = new ExtensionRunner([], {} as any, "/tmp", {} as any, {} as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runner as any).getSystemPromptOptionsFn = () => ({ patched: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (runner as any).assertActive = () => {};
  return runner;
}

describe("ext-context-get-system-prompt-options patch", () => {
  test("createContext() exposes a working getSystemPromptOptions()", () => {
    const ctx = makeRunner().createContext() as unknown as { getSystemPromptOptions: () => unknown };
    expect(typeof ctx.getSystemPromptOptions).toBe("function");
    expect(ctx.getSystemPromptOptions()).toEqual({ patched: true });
  });

  test("getSystemPromptOptions is a writable DATA property, not a getter-only accessor", () => {
    const ctx = makeRunner().createContext();
    const desc = Object.getOwnPropertyDescriptor(ctx, "getSystemPromptOptions");
    expect(desc).toBeDefined();
    // Must be a data property (has `value`, `writable`), NOT an accessor (`get`/`set`).
    expect(desc!.writable).toBe(true);
    expect(desc!.configurable).toBe(true);
    expect("value" in desc!).toBe(true);
    expect(desc!.get).toBeUndefined();
    expect(desc!.set).toBeUndefined();
  });

  test("createCommandContext pattern (copy descriptors + assign) does not throw", () => {
    // This is the exact pattern runner.createCommandContext() uses. With the old
    // getter-only accessor, the assignment below threw in strict mode.
    const runner = makeRunner();
    const ctx = runner.createContext();
    const copy = Object.defineProperties(
      {},
      Object.getOwnPropertyDescriptors(ctx),
    );
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (copy as any).getSystemPromptOptions = () => "overridden-by-command-context";
    }).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((copy as any).getSystemPromptOptions()).toBe("overridden-by-command-context");
  });
});
