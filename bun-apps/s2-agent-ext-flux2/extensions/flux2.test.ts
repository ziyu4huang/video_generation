import { describe, expect, test } from "bun:test";
import extension, { coerceOptions } from "./flux2.ts";
import { PathSafetyError, COMMAND_LIST } from "../src/index.ts";

// Wiring test for the extension factory itself — exercises the same
// execute() path a real pi agent session would call, without spinning up a
// live LLM (no provider/API key needed). runFlux2()'s own behavior is
// covered exhaustively in src/*.test.ts; this only checks the extension
// registers well-formed tools and that execute() shapes results correctly.

function captureRegisteredTools() {
  const registered: any[] = [];
  const fakePi = {
    registerTool(tool: any) {
      registered.push(tool);
    },
    on(_event: string, _handler: (...args: any[]) => void) {
      // no-op: session_start handler not exercised in unit tests
    },
    getActiveTools() {
      return [];
    },
    setActiveTools(_tools: string[]) {
      // no-op
    },
  } as any;
  extension(fakePi);
  return registered;
}

function getTool(name: string) {
  const tool = captureRegisteredTools().find((t) => t.name === name);
  if (!tool) throw new Error(`tool '${name}' not registered`);
  return tool;
}

const ALL_COMMANDS = COMMAND_LIST.map((c) => c.name);

describe("pi-flux2 extension", () => {
  test("registers exactly two tools: flux2 + flux2_help", () => {
    const tools = captureRegisteredTools();
    expect(tools.map((t: any) => t.name).sort()).toEqual(["flux2", "flux2_help"]);
  });

  test("flux2 description routes to flux2_help; flux2_help (no args) documents every subcommand", async () => {
    const tool = getTool("flux2");
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(60);
    expect(tool.description.length).toBeLessThan(300);
    // Slim description routes to flux2_help and does NOT embed subcommands inline.
    expect(tool.description).toContain("flux2_help");
    expect(tool.description).not.toContain(ALL_COMMANDS[0]);

    // The subcommand list now lives in flux2_help's no-arg output (commandIndex).
    const help = getTool("flux2_help");
    const res = await help.execute("id", {});
    const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
    for (const cmd of ALL_COMMANDS) {
      expect(text).toContain(cmd);
    }
  });

  test("flux2 description no longer embeds the heavy per-command field reference", () => {
    const tool = getTool("flux2");
    // The old description embedded every option key for every command. The slim
    // one must NOT carry, e.g., the scene-specific option lines.
    expect(tool.description).not.toContain("[--ref-count-per-image]");
    expect(tool.description).not.toContain("[--hand-repair-strength]");
  });

  test("execute() surfaces a PathSafetyError as a non-throwing tool result", async () => {
    const tool = getTool("flux2");
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
    const tool = getTool("flux2");
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
    const tool = getTool("flux2");
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
    const tool = getTool("flux2");
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

describe("flux2_help companion tool", () => {
  test("command omitted → returns the subcommand index mentioning every command", async () => {
    const help = getTool("flux2_help");
    const result = await help.execute("h0", {}, undefined, undefined, {});
    const text = result.content[0].text;
    for (const cmd of ALL_COMMANDS) {
      expect(text).toContain(cmd);
    }
    expect(text).toContain("scene-pipeline");
    expect(text).toContain("self-improve");
  });

  test("command:'scene' → returns the SAME field reference the old description embedded", async () => {
    const help = getTool("flux2_help");
    const result = await help.execute("h-scene", { command: "scene" }, undefined, undefined, {});
    const text = result.content[0].text;
    // No lost capability: every scene option key + its CLI flag is present, in
    // the exact "• key[] path [flag] — desc" shape the old description used.
    expect(text).toContain("── scene ──");
    expect(text).toContain("ref[] path [--ref]");
    expect(text).toContain("refCountPerImage [--ref-count-per-image]");
    expect(text).toContain("refStrength[] [--ref-strength]");
    expect(text).toContain("handRepair [--hand-repair]");
    expect(text).toContain("handRepairStrength [--hand-repair-strength]");
    expect(text).toContain("bg path [--bg]");
    expect(text).toContain("lora[] [--lora]");
    expect(text).toContain("strictGate [--strict-gate]");
    // The flagship command must carry a worked example.
    expect(text).toContain("Example:");
  });

  test("command:'gate' → positional flag noted + example present", async () => {
    const help = getTool("flux2_help");
    const result = await help.execute("h-gate", { command: "gate" }, undefined, undefined, {});
    const text = result.content[0].text;
    expect(text).toContain("── gate ──");
    expect(text).toContain("(positional)");
    expect(text).toContain("Example:");
  });

  test('topic:"scene-pipeline" → returns the multi-seed pipeline docs', async () => {
    const help = getTool("flux2_help");
    const result = await help.execute("h-sp", { topic: "scene-pipeline" }, undefined, undefined, {});
    const text = result.content[0].text;
    expect(text).toContain("Multi-seed scene pipeline");
    expect(text).toContain("verifyPrompt");
    expect(text).toContain("handRepairWinner");
  });

  test('topic:"self-improve" → returns the self-improve loop docs', async () => {
    const help = getTool("flux2_help");
    const result = await help.execute("h-si", { topic: "self-improve" }, undefined, undefined, {});
    const text = result.content[0].text;
    expect(text).toContain("Self-improve loop");
    expect(text).toContain("run-self-improve-loop.sh");
  });

  test("topic takes precedence over command when both are set", async () => {
    const help = getTool("flux2_help");
    const result = await help.execute("h-both", { command: "scene", topic: "self-improve" }, undefined, undefined, {});
    expect(result.content[0].text).toContain("Self-improve loop");
  });

  test("unknown command → helpful error, no throw", async () => {
    const help = getTool("flux2_help");
    const result = await help.execute("h-bad", { command: "nope" }, undefined, undefined, {});
    expect(result.content[0].text).toContain("Unknown command");
    expect(result.content[0].text).toContain("scene");
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
