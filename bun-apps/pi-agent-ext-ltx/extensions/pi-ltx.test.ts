import { describe, expect, test } from "bun:test";
import extension from "./pi-ltx.ts";
import { PathSafetyError } from "../src/index.ts";

// Wiring test for the extension factory itself — exercises the same
// execute() path a real pi agent session would call, without spinning up a
// live LLM (no provider/API key needed). runLtx()'s own behavior is covered
// exhaustively in src/*.test.ts; this only checks the extension registers a
// well-formed tool and that execute() shapes results correctly.

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

describe("pi-ltx extension", () => {
  test("registers exactly one tool named 'ltx' with a non-empty description", () => {
    const tool = captureRegisteredTool();
    expect(tool).not.toBeNull();
    expect(tool.name).toBe("ltx");
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(100);
  });

  test("the description documents every one of the 10 subcommands", () => {
    const tool = captureRegisteredTool();
    for (const cmd of [
      "t2i", "native-i2v", "native-upscale", "i2v", "upscale",
      "gate", "verify", "models", "audio-decode", "video-decode",
    ]) {
      expect(tool.description).toContain(cmd);
    }
  });

  test("execute() surfaces a PathSafetyError as a non-throwing tool result", async () => {
    const tool = captureRegisteredTool();
    const result = await tool.execute(
      "call-1",
      { command: "upscale", options: { input: "/definitely/does/not/exist.mp4" } },
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
    expect(result.content[0].text).toContain("Unknown ltx-video command");
  });
});

// Sanity: PathSafetyError is re-exported from src/index.ts (used above and by
// the extension's own catch block) — guards against an accidental export drop.
test("PathSafetyError is importable from src/index.ts", () => {
  expect(new PathSafetyError("x")).toBeInstanceOf(Error);
});
