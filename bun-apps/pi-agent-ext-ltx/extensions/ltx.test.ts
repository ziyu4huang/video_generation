import { describe, expect, test } from "bun:test";
import extension from "./ltx.ts";
import { PathSafetyError, COMMAND_LIST } from "../src/index.ts";

// Wiring test for the extension factory itself — exercises the same
// execute() path a real pi agent session would call, without spinning up a
// live LLM (no provider/API key needed). runLtx()'s own behavior is covered
// exhaustively in src/*.test.ts; this only checks the extension registers
// well-formed tools and that execute() shapes results correctly.

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

describe("pi-ltx extension", () => {
  test("registers exactly two tools: ltx + ltx_help", () => {
    const tools = captureRegisteredTools();
    expect(tools.map((t: any) => t.name).sort()).toEqual(["ltx", "ltx_help"]);
  });

  test("ltx description routes to ltx_help; ltx_help (no args) documents every subcommand", async () => {
    const tool = getTool("ltx");
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(60);
    expect(tool.description.length).toBeLessThan(300);
    // The slim description must point the model at ltx_help and must NOT embed
    // the subcommand list inline (that bloat was the reason for the trim).
    expect(tool.description).toContain("ltx_help");
    expect(tool.description).not.toContain(ALL_COMMANDS[0]);

    // The subcommand list now lives in ltx_help's no-arg output (commandIndex).
    const help = getTool("ltx_help");
    const res = await help.execute("id", {});
    const text = (res.content as Array<{ type: string; text?: string }>)[0].text ?? "";
    for (const cmd of ALL_COMMANDS) {
      expect(text).toContain(cmd);
    }
  });

  test("ltx description no longer embeds the heavy per-command field reference", () => {
    const tool = getTool("ltx");
    // The old description embedded every option key for every command. The slim
    // one must NOT carry, e.g., native-i2v's verbose option lines.
    expect(tool.description).not.toContain("[--last-frame-derives-resolution]");
    expect(tool.description).not.toContain("[--refine-audio]");
  });

  test("execute() surfaces a PathSafetyError as a non-throwing tool result", async () => {
    const tool = getTool("ltx");
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
    const tool = getTool("ltx");
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

  // Regression: at least one provider/model pair (zai/glm-5.2) serializes the
  // `Type.Any()` options param as a JSON STRING in the tool-call payload.
  // Before coerceOptions, `key in options` then threw "options is not an
  // Object" and killed EVERY call (including ones the agent reported as `{}`).
  // Confirmed live via a real A/B upscale-verification run: native-i2v/gate
  // calls broke this exact way through the real tool boundary. These prove the
  // boundary normalizes a string into a real object so the downstream
  // path-validation / command-dispatch path actually runs.
  test("execute() accepts options as a JSON string and still reaches path validation", async () => {
    const tool = getTool("ltx");
    const result = await tool.execute(
      "call-str",
      { command: "upscale", options: JSON.stringify({ input: "/definitely/does/not/exist.mp4" }) },
      undefined,
      undefined,
      {},
    );
    expect(result.details.ok).toBe(false);
    expect(result.details.pathSafety).toBe(true);
    expect(result.content[0].text).toContain("path-safety");
  });

  test("execute() accepts options as undefined/empty-string without throwing", async () => {
    const tool = getTool("ltx");
    for (const opts of [undefined, "", "   "]) {
      const result = await tool.execute(
        "call-empty",
        { command: "not-a-real-command", options: opts },
        undefined,
        undefined,
        {},
      );
      expect(result.details.ok).toBe(false);
      expect(result.content[0].text).toContain("Unknown ltx-video command");
    }
  });

  test("execute() accepts a JSON string array for gate's positional videos field", async () => {
    const tool = getTool("ltx");
    const result = await tool.execute(
      "call-gate-str",
      { command: "gate", options: JSON.stringify({ videos: ["/definitely/does/not/exist.mp4"], json: true }) },
      undefined,
      undefined,
      {},
    );
    expect(result.details.ok).toBe(false);
    expect(result.details.pathSafety).toBe(true);
  });
});

describe("ltx_help companion tool", () => {
  test("command omitted → returns the subcommand index mentioning every command", async () => {
    const help = getTool("ltx_help");
    const result = await help.execute("h0", {}, undefined, undefined, {});
    const text = result.content[0].text;
    for (const cmd of ALL_COMMANDS) {
      expect(text).toContain(cmd);
    }
    expect(text).toContain("native-vs-prod");
  });

  test("command:'native-i2v' → returns the SAME field reference the old description embedded", async () => {
    const help = getTool("ltx_help");
    const result = await help.execute("h-i2v", { command: "native-i2v" }, undefined, undefined, {});
    const text = result.content[0].text;
    // No lost capability: native-i2v's option keys + CLI flags are present, in
    // the exact "• key[] path [flag] — desc" shape the old description used.
    expect(text).toContain("── native-i2v ──");
    expect(text).toContain("lastFrame path [--last-frame]");
    expect(text).toContain("lastFrameStrength [--last-frame-strength]");
    expect(text).toContain("lastFrameDerivesResolution [--last-frame-derives-resolution]");
    expect(text).toContain("audioTrack path [--audio-track]");
    expect(text).toContain("inputImage path [--input-image]");
    expect(text).toContain("loras[] path [--lora]");
    expect(text).toContain("upscale [--upscale / --no-upscale]"); // tri-state boolean shape preserved
    expect(text).toContain("gridFrameIndices[] [--grid-frame-indices]");
    expect(text).toContain("Example:");
  });

  test("command:'gate' → positional flag noted + example present", async () => {
    const help = getTool("ltx_help");
    const result = await help.execute("h-gate", { command: "gate" }, undefined, undefined, {});
    const text = result.content[0].text;
    expect(text).toContain("── gate ──");
    expect(text).toContain("(positional)");
    expect(text).toContain("Example:");
  });

  test('topic:"native-vs-prod" → returns the native-i2v-vs-i2v docs', async () => {
    const help = getTool("ltx_help");
    const result = await help.execute("h-np", { topic: "native-vs-prod" }, undefined, undefined, {});
    const text = result.content[0].text;
    expect(text).toContain("native-i2v vs i2v");
    expect(text).toContain("production pipeline");
  });

  test("topic takes precedence over command when both are set", async () => {
    const help = getTool("ltx_help");
    const result = await help.execute("h-both", { command: "native-i2v", topic: "native-vs-prod" }, undefined, undefined, {});
    expect(result.content[0].text).toContain("native-i2v vs i2v");
  });

  test("unknown command → helpful error, no throw", async () => {
    const help = getTool("ltx_help");
    const result = await help.execute("h-bad", { command: "nope" }, undefined, undefined, {});
    expect(result.content[0].text).toContain("Unknown command");
    expect(result.content[0].text).toContain("native-i2v");
  });
});

// Sanity: PathSafetyError is re-exported from src/index.ts (used above and by
// the extension's own catch block) — guards against an accidental export drop.
test("PathSafetyError is importable from src/index.ts", () => {
  expect(new PathSafetyError("x")).toBeInstanceOf(Error);
});
