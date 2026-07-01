import { describe, expect, test } from "bun:test";
import extension from "./pi-flux2.ts";
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
});

// Sanity: PathSafetyError is re-exported from src/index.ts (used above and by
// the extension's own catch block) — guards against an accidental export drop.
test("PathSafetyError is importable from src/index.ts", () => {
  expect(new PathSafetyError("x")).toBeInstanceOf(Error);
});
