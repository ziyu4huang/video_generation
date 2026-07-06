import { describe, expect, test } from "bun:test";
import extension from "./pi-movie-director.ts";
import { scopeViolationForToolCall } from "../src/index.ts";

// Wiring test for the extension factory — registers one well-formed tool and
// dispatch() shapes results correctly. Deep behavior is covered in src/*.test.ts.

function captureRegisteredTool() {
  let registered: any = null;
  const fakePi = {
    registerTool(tool: any) {
      registered = tool;
    },
    on() {
      /* tool_call guard registration; exercised via scopeViolationForToolCall tests */
    },
  } as any;
  extension(fakePi);
  return registered;
}

describe("pi-movie-director extension", () => {
  test("registers exactly one tool named 'movie' with a non-empty description", () => {
    const tool = captureRegisteredTool();
    expect(tool).not.toBeNull();
    expect(tool.name).toBe("movie");
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeGreaterThan(100);
  });

  test("the description documents every command", () => {
    const tool = captureRegisteredTool();
    for (const cmd of [
      "preflight", "pipeline-list", "pipeline-show", "init-project", "next-stage",
      "write-checkpoint", "read-checkpoint", "validate-artifact", "generate",
      "compose", "final-review",
      "cost-estimate", "cost-reserve", "cost-reconcile", "cost-snapshot",
    ]) {
      expect(tool.description).toContain(cmd);
    }
  });

  test("the generate description documents BOTH analysis subcommands (agent-discoverability)", () => {
    // Regression: the `movie` tool's generate description used to mention only
    // `analysis:transcribe` (audio). A hint-free "identify the VISUAL content"
    // prompt left the agent unable to discover the CLIP path, so it guessed
    // `transcribe` and omitted `capability` → a non-converging retry loop
    // (the "video_understand agent-path block"). The description MUST surface
    // `video_understand` and its options so a hint-free agent routes correctly.
    const tool = captureRegisteredTool();
    expect(tool.description).toContain("video_understand");
    expect(tool.description).toContain("transcribe");
    // The visual-analysis option keys (so the agent doesn't guess `video_path`).
    expect(tool.description).toMatch(/video_understand[^]*options:\{video,\s*prompt/);
    expect(tool.description).toContain("VISUAL");
  });

  test("preflight returns the provider-menu summary", async () => {
    const tool = captureRegisteredTool();
    const res = await tool.execute("id", { command: "preflight", options: {} }, undefined, undefined, undefined);
    const text = res.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.capabilities.length).toBeGreaterThan(0);
    expect(parsed.composition_runtimes).toBeDefined();
  });

  test("pipeline-list returns the bundled manifests", async () => {
    const tool = captureRegisteredTool();
    const res = await tool.execute("id", { command: "pipeline-list", options: {} }, undefined, undefined, undefined);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed).toContain("talking-head");
  });

  test("write-checkpoint surfaces gate violation as a non-throwing error result", async () => {
    const tool = captureRegisteredTool();
    const res = await tool.execute(
      "id",
      {
        command: "write-checkpoint",
        options: {
          projectId: "p-gate", pipeline: "talking-head", stage: "idea", status: "completed",
          // humanApproved omitted → gate violation
        },
      },
      undefined, undefined, undefined,
    );
    expect(res.details.ok).toBe(false);
    expect(res.content[0].text).toContain("GATE VIOLATION");
  });

  test("generate surfaces a no-configured-provider error as a structured failure (no spawn)", async () => {
    // tts has NO configured provider → the selector throws NoConfiguredProviderError,
    // which dispatch converts to {ok:false, error}. No subprocess is ever spawned.
    const tool = captureRegisteredTool();
    const res = await tool.execute(
      "id",
      { command: "generate", options: { capability: "tts", command: "synthesize" } },
      undefined, undefined, undefined,
    );
    expect(res.details.ok).toBe(false);
    expect(res.details.error).toContain("no configured provider");
  });

  test("the factory registers the tool_call scope guard", () => {
    // The extension calls pi.on("tool_call", handler) with the scope-violation
    // predicate. Capture the handler and prove it blocks the #291 path.
    let registeredHandler: ((e: any) => any) | null = null;
    const fakePi = {
      registerTool() {},
      on(event: string, handler: (e: any) => any) {
        if (event === "tool_call") registeredHandler = handler;
      },
    } as any;
    extension(fakePi);
    expect(registeredHandler).not.toBeNull();
    const block = registeredHandler!({ toolName: "edit", input: { path: "python/mlx-movie-director/app/config.py", edits: [] } });
    expect(block?.block).toBe(true);
    expect(block?.reason).toContain("out of scope");
    // A safe path is allowed through.
    expect(registeredHandler!({ toolName: "write", input: { path: "/tmp/x.mp4", content: "x" } })).toBeUndefined();
    // And the handler delegates to the pure predicate (same verdict for the same input).
    expect(registeredHandler!({ toolName: "edit", input: { path: "swift/x.swift", edits: [] } })).toEqual(
      scopeViolationForToolCall({ toolName: "edit", input: { path: "swift/x.swift", edits: [] } }),
    );
  });
});
