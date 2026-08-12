/**
 * stealth-trim.test.ts — regression guard: the vlm tools must stay free of
 * per-turn system-prompt injection (`promptSnippet`/`promptGuidelines`).
 * The rich `description` already routes the model; the snippet was redundant.
 *
 * Captures the registered tools via the extension factory + a mock pi (Proxy
 * swallows `pi.on`/`pi.registerCommand`/etc.; only `registerTool` is captured),
 * so this tests the ACTUAL tool definitions the LLM sees.
 */
import { expect, test } from "bun:test";
import extensionFactory from "../file2md.ts";

function captureTools(): Record<string, Record<string, unknown>> {
  const tools: Record<string, Record<string, unknown>> = {};
  const mockPi = new Proxy(
    {
      registerTool: (t: Record<string, unknown>) => {
        tools[t.name as string] = t;
      },
    },
    {
      get(target, prop) {
        return prop in target ? Reflect.get(target, prop) : () => {};
      },
    },
  );
  extensionFactory(mockPi as never);
  return tools;
}

test("vlm tools are stealth-trimmed: no promptSnippet/guidelines", () => {
  const tools = captureTools();
  expect(Object.keys(tools).sort()).toEqual(["file2md", "vision_ask"]);

  for (const [name, tool] of Object.entries(tools)) {
    // Routing description still present (the model needs it).
    expect(typeof tool.description).toBe("string");
    expect(String(tool.description).length).toBeGreaterThan(20);
    // Stealth: no per-turn system-prompt injection.
    expect(tool.promptSnippet, `${name}.promptSnippet`).toBeUndefined();
    expect(tool.promptGuidelines, `${name}.promptGuidelines`).toBeUndefined();
  }
});
