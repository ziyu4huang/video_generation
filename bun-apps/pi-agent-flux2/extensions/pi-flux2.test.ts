import { describe, expect, test } from "bun:test";
import extension, { coerceOptions } from "./pi-flux2.ts";
import { PathSafetyError } from "../src/index.ts";

// Wiring test for the extension factory itself — exercises the same
// execute() path a real pi agent session would call, without spinning up a
// live LLM (no provider/API key needed). runFlux2()'s own behavior is
// covered exhaustively in src/*.test.ts; this only checks the extension
// registers a well-formed tool and that execute() shapes results correctly.

function captureRegisteredTool() {
  let registered: any = null;
  const fakePi = {
    registerTool(tool: any) {
      registered = tool;
    },
  } as any;
  extension(fakePi);
  return registered;
}

describe("pi-flux2 extension", () => {
  test("registers exactly one tool named 'flux2' with a non-empty description", () => {
    const tool = captureRegisteredTool();
    expect(tool).not.toBeNull();
    expect(tool.name).toBe("flux2");
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(100);
  });

  test("the description documents every one of the 18 subcommands", () => {
    const tool = captureRegisteredTool();
    for (const cmd of [
      "t2i", "scene", "edit", "style", "angle", "swap", "expand", "upscale",
      "gate", "segment", "story", "models",
      "verify-vae", "verify-encoder", "verify-tokenizer", "verify-transformer",
      "verify-e2e", "verify-edit",
    ]) {
      expect(tool.description).toContain(cmd);
    }
  });

  test("execute() surfaces a PathSafetyError as a non-throwing tool result", async () => {
    const tool = captureRegisteredTool();
    const result = await tool.execute(
      "call-1",
      { command: "upscale", options: { input: "/definitely/does/not/exist.png" } },
      undefined,
      undefined,
      {},
    );
    expect(result.content[0].text).toContain("path-safety");
    expect(result.details.ok).toBe(false);
    expect(result.details.pathSafety).toBe(true);
  });

  test("execute() surfaces an unknown-command error as a non-throwing tool result", async () => {
    const tool = captureRegisteredTool();
    const result = await tool.execute(
      "call-2",
      { command: "not-a-real-command", options: {} },
      undefined,
      undefined,
      {},
    );
    expect(result.details.ok).toBe(false);
    expect(result.content[0].text).toContain("Unknown flux2 command");
  });

  // Regression: at least one provider/model pair (zai/glm-5.2) serializes the
  // `Type.Any()` options param as a JSON STRING in the tool-call payload.
  // Before coerceOptions, `key in options` then threw "options is not an
  // Object" and killed EVERY call (including ones the agent reported as `{}`).
  // These prove the boundary normalizes a string into a real object so the
  // downstream path-validation / command-dispatch path actually runs.
  test("execute() accepts options as a JSON string and still reaches path validation", async () => {
    const tool = captureRegisteredTool();
    const result = await tool.execute(
      "call-str",
      { command: "upscale", options: JSON.stringify({ input: "/definitely/does/not/exist.png" }) },
      undefined,
      undefined,
      {},
    );
    // Not a throw, not an "options is not an Object" error — the string was
    // parsed and path-validation rejected the bad input path.
    expect(result.details.ok).toBe(false);
    expect(result.details.pathSafety).toBe(true);
    expect(result.content[0].text).toContain("path-safety");
  });

  test("execute() accepts options as undefined/empty-string without throwing", async () => {
    const tool = captureRegisteredTool();
    for (const opts of [undefined, "", "   "]) {
      const result = await tool.execute(
        "call-empty",
        { command: "not-a-real-command", options: opts },
        undefined,
        undefined,
        {},
      );
      // Reaches the unknown-command path (options coerced to {} cleanly), never
      // the "options is not an Object" TypeError.
      expect(result.details.ok).toBe(false);
      expect(result.content[0].text).toContain("Unknown flux2 command");
    }
  });
});

describe("coerceOptions", () => {
  test("passes a plain object through unchanged", () => {
    const o = { prompt: "x", steps: 4 };
    expect(coerceOptions(o)).toEqual(o);
  });
  test("parses a JSON object string", () => {
    expect(coerceOptions(JSON.stringify({ prompt: "x" }))).toEqual({ prompt: "x" });
  });
  test("returns {} for undefined/null/array/primitive/garbage", () => {
    for (const v of [undefined, null, 42, true, [], "[1,2]", "not json{", '{"a":1 ']) {
      expect(coerceOptions(v)).toEqual({});
    }
  });
});

// Sanity: PathSafetyError is re-exported from src/index.ts (used above and by
// the extension's own catch block) — guards against an accidental export drop.
test("PathSafetyError is importable from src/index.ts", () => {
  expect(new PathSafetyError("x")).toBeInstanceOf(Error);
});
